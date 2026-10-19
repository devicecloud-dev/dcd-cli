import { defineCommand } from 'citty';
import { existsSync } from 'node:fs';

import { apiFlags } from '../config/flags/api.flags.js';
import { jsonFlag } from '../config/flags/output.flags.js';
import { DeviceApiError, DeviceGateway } from '../gateways/device-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import {
  type DeviceCatalogue,
  type DeviceCommandResult,
  type DeviceInstalledApp,
  type DeviceSession,
  ENDED_STATES,
  type StartDeviceSessionRequest,
} from '../types/domain/device-session.types.js';
import { platformOfAppFile, uploadLocalApp } from '../utils/app-upload.js';
import { resolveAuth } from '../utils/auth.js';
import { CliError, logger, validateEnum } from '../utils/cli.js';
import { resolveApiUrl } from '../utils/config-store.js';
import {
  deviceProgress,
  printSession,
  resolveSessionId,
  runDeviceCommand,
} from '../utils/device-output.js';
import { isUrl } from '../utils/expo.js';
import { colors } from '../utils/styling.js';
import { ui } from '../utils/ui.js';

const PLATFORMS = ['android', 'ios'] as const;
/** What `--name` defaults to: shown in the console and the session timeline. */
const DEFAULT_CLIENT_LABEL = 'dcd-cli';
const WAIT_POLL_MS = 2000;
/** Longer than the API's own queue timeout, so that one is what ends a wait. */
const WAIT_TIMEOUT_MS = 20 * 60 * 1000;
/** States in which a session takes commands. */
const USABLE_STATES = new Set(['active', 'needs_human', 'ready']);

/** Every `dcd device` subcommand takes these. */
const commonArgs = { ...apiFlags, json: jsonFlag } as const;

const idArg = {
  type: 'positional',
  required: false,
  description: 'Session id, e.g. brave-teal-otter. Optional when exactly one session is open.',
} as const;

interface Ctx {
  apiUrl: string;
  auth: AuthContext;
  json: boolean;
  progress: (message: string) => void;
}

async function context(args: Record<string, unknown>): Promise<Ctx> {
  const json = Boolean(args.json);
  return {
    apiUrl: resolveApiUrl(args['api-url'] as string | undefined),
    auth: await resolveAuth({ apiKeyFlag: args['api-key'] as string | undefined }),
    json,
    progress: deviceProgress(json),
  };
}

/** A spinner only for a person at a terminal (plan 4.2: none when not a TTY). */
function interactive(json: boolean): boolean {
  return !json && process.stdout.isTTY === true && process.stdin.isTTY === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until the session takes commands. Reports each change of state (and
 * queue position) as progress. A session that ends while waiting is exit 4.
 */
async function waitUntilUsable(ctx: Ctx, id: string): Promise<DeviceSession> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last = '';
  for (;;) {
    const { session } = await DeviceGateway.status(ctx.apiUrl, ctx.auth, id);
    if (USABLE_STATES.has(session.state)) return session;
    if (ENDED_STATES.includes(session.state)) {
      throw new DeviceApiError(
        `Device session ${id} ended while starting (${session.release_reason ?? session.state}).`,
        410,
        'LIVE_SESSION_ENDED',
        session,
      );
    }

    const position = session.queue?.position;
    const line = position ? `${session.state} (position ${position} in the queue)` : session.state;
    if (line !== last) {
      last = line;
      ctx.progress(`   ${colors.dim(line)}`);
    }

    if (Date.now() >= deadline) {
      throw new DeviceApiError(
        `Timed out after ${WAIT_TIMEOUT_MS / 60_000} minutes waiting for ${id} (state: ${session.state}). It is still open: check it with \`dcd device status ${id}\`.`,
        408,
        null,
        session,
      );
    }

    await sleep(WAIT_POLL_MS);
  }
}

/**
 * Turn `<path|url>` into what /install takes: a URL goes to the API's
 * install-from-URL, a local file is uploaded first.
 */
async function resolveApp(
  ctx: Ctx,
  app: string,
): Promise<{ binaryUploadId: string } | { url: string }> {
  if (isUrl(app)) return { url: app };
  if (!existsSync(app)) throw new CliError(`No such file: ${app}`);
  ctx.progress(ui.running(`Uploading ${colors.highlight(app)}…`));
  const binaryUploadId = await uploadLocalApp({
    apiUrl: ctx.apiUrl,
    auth: ctx.auth,
    filePath: app,
    log: ctx.progress,
    showProgress: interactive(ctx.json),
  });
  return { binaryUploadId };
}

function parsePositiveInt(value: unknown, flag: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(`--${flag} must be a whole number of minutes, got "${String(value)}".`);
  }

  return n;
}

const startSub = defineCommand({
  meta: { name: 'start', description: 'Start a device session' },
  args: {
    ...commonArgs,
    platform: {
      type: 'string',
      description: 'ios or android. Optional with --app, which implies it',
    },
    model: {
      type: 'string',
      description: 'Device model, e.g. iphone-16 or pixel-10 (see `dcd device models`)',
    },
    os: {
      type: 'string',
      description: 'iOS major version or Android API level, e.g. 18 or 35',
    },
    'google-play': {
      type: 'boolean',
      description: '[Android] An image with Google Play services',
    },
    app: {
      type: 'string',
      description: 'A build to install: a local .apk/.app/.zip/.tar.gz (uploaded first) or an https URL',
    },
    'app-binary-id': {
      type: 'string',
      description: 'An already uploaded build to install',
    },
    locale: {
      type: 'string',
      description: 'Device locale, e.g. de_DE',
    },
    name: {
      type: 'string',
      description: `Who is driving the session, shown in the console (default: ${DEFAULT_CLIENT_LABEL})`,
    },
    ttl: {
      type: 'string',
      description: "Longest the session may run, in minutes (default: your org's limit)",
    },
    record: {
      type: 'boolean',
      default: true,
      description: 'Record a video of the session (--no-record to turn off)',
    },
    wait: {
      type: 'boolean',
      default: false,
      description: 'Wait until the device is ready for commands',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const app = args.app as string | undefined;
      const binaryId = args['app-binary-id'] as string | undefined;
      if (app && binaryId) throw new CliError('Pass --app or --app-binary-id, not both.');

      const platform =
        validateEnum(args.platform as string | undefined, PLATFORMS, 'platform') ??
        (app && !isUrl(app) ? platformOfAppFile(app) : undefined);
      if (!platform) {
        throw new CliError('--platform is required (ios or android).');
      }

      const appPlatform = app && !isUrl(app) ? platformOfAppFile(app) : undefined;
      if (appPlatform && appPlatform !== platform) {
        throw new CliError(`${app} is a build for ${appPlatform}, not ${platform}.`);
      }

      if (args['google-play'] && platform !== 'android') {
        throw new CliError('--google-play is only for Android.');
      }

      const ctx = await context(args);
      const resolved = app ? await resolveApp(ctx, app) : undefined;
      const uploadedId =
        binaryId ?? (resolved && 'binaryUploadId' in resolved ? resolved.binaryUploadId : undefined);

      const body: StartDeviceSessionRequest = {
        platform,
        clientLabel: (args.name as string | undefined) || DEFAULT_CLIENT_LABEL,
        ...(uploadedId && { binaryUploadId: uploadedId }),
        ...(args.model ? { model: args.model as string } : {}),
        ...(args.os ? { os: String(args.os) } : {}),
        ...(args['google-play'] ? { googlePlay: true } : {}),
        ...(args.locale ? { deviceLocale: args.locale as string } : {}),
        ...(args.record === false ? { record: false } : {}),
      };
      const ttl = parsePositiveInt(args.ttl, 'ttl');
      if (ttl) body.maxDurationMin = ttl;

      ctx.progress(ui.running(`Starting ${platform} device session…`));
      let { session } = await DeviceGateway.start(ctx.apiUrl, ctx.auth, body);
      ctx.progress(ui.success(`Session ${session.id} started`));

      // The session exists and bills from here on: every later failure must
      // still name it, so the caller can stop it.
      try {
        if (resolved && 'url' in resolved) {
          ctx.progress(ui.running('Installing the app from its URL…'));
          ({ session } = await DeviceGateway.install(ctx.apiUrl, ctx.auth, session.id, resolved));
        }

        if (args.wait) {
          ctx.progress(ui.running('Waiting for the device…'));
          session = await waitUntilUsable(ctx, session.id);
        }
      } catch (error) {
        if (error instanceof DeviceApiError && error.code === 'LIVE_SESSION_ENDED') throw error;
        const message = `${error instanceof Error ? error.message : String(error)} Session ${session.id} is still open: stop it with \`dcd device stop ${session.id}\`.`;
        if (error instanceof DeviceApiError) {
          throw new DeviceApiError(message, error.status, error.code, error.session ?? session);
        }

        throw new DeviceApiError(message, 500, null, session);
      }

      return {
        session,
        data: { binary_upload_id: uploadedId ?? null },
        print() {
          logger.log(ui.section('Device session'));
          printSession(session);
          logger.log(ui.section('Next steps'));
          logger.log(
            ui.branch(
              ui.fields([
                ['inspect the screen', colors.highlight(`dcd device inspect ${session.id}`)],
                ['run a flow', colors.highlight(`dcd device run ${session.id} flow.yaml`)],
                ['stop', colors.highlight(`dcd device stop ${session.id}`)],
              ]),
            ),
          );
        },
      };
    });
  },
});

const listSub = defineCommand({
  meta: { name: 'list', description: "List your org's open device sessions" },
  args: {
    ...commonArgs,
    all: {
      type: 'boolean',
      default: false,
      description: 'Include sessions that ended in the last 24 hours',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      const { sessions } = await DeviceGateway.list(ctx.apiUrl, ctx.auth, Boolean(args.all));
      return {
        session: null,
        data: { sessions },
        print() {
          if (sessions.length === 0) {
            logger.log(ui.info(args.all ? 'No device sessions in the last 24 hours.' : 'No open device sessions.'));
            return;
          }

          logger.log(ui.section(`Device sessions (${sessions.length})`));
          logger.log(
            ui.branch(
              ui.fields(
                sessions.map((s) => [
                  colors.highlight(s.id),
                  [s.state, s.platform, s.model, s.client_label].filter(Boolean).join('  '),
                ]),
              ),
            ),
          );
        },
      };
    });
  },
});

const statusSub = defineCommand({
  meta: { name: 'status', description: "A session's state, time left and cost" },
  args: { ...commonArgs, id: idArg },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const { session } = await DeviceGateway.status(ctx.apiUrl, ctx.auth, id);
      return {
        session,
        data: null,
        print() {
          logger.log(ui.section('Device session'));
          printSession(session);
        },
      };
    });
  },
});

const stopSub = defineCommand({
  meta: { name: 'stop', description: 'Stop a session, or every open one with --all' },
  args: {
    ...commonArgs,
    id: idArg,
    all: { type: 'boolean', default: false, description: "Stop every open session in your org" },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      if (args.all) {
        if (args.id) throw new CliError('Pass a session id or --all, not both.');
        const { sessions } = await DeviceGateway.list(ctx.apiUrl, ctx.auth);
        const stopped: DeviceSession[] = [];
        for (const s of sessions) {
          stopped.push((await DeviceGateway.stop(ctx.apiUrl, ctx.auth, s.id)).session);
        }

        return {
          session: null,
          data: { stopped },
          print() {
            logger.log(
              stopped.length === 0
                ? ui.info('No open device sessions to stop.')
                : ui.success(`Stopped ${stopped.map((s) => s.id).join(', ')}`),
            );
          },
        };
      }

      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const { session } = await DeviceGateway.stop(ctx.apiUrl, ctx.auth, id);
      return {
        session,
        data: null,
        print() {
          logger.log(ui.success(`Stopped ${session.id}`));
          printSession(session);
        },
      };
    });
  },
});

/**
 * `install [id] <path|url>`: with one positional it is the app when it looks
 * like one (a URL, a file that exists, or a build's extension).
 */
function looksLikeApp(value: string): boolean {
  return isUrl(value) || existsSync(value) || platformOfAppFile(value) !== undefined;
}

const installSub = defineCommand({
  meta: { name: 'install', description: 'Install a build: a local file (uploaded first) or an https URL' },
  args: {
    ...commonArgs,
    id: idArg,
    app: {
      type: 'positional',
      required: false,
      description: 'A local .apk/.app/.zip/.tar.gz, or an https URL to an .apk or a zipped .app',
    },
    'app-binary-id': { type: 'string', description: 'An already uploaded build' },
    wait: {
      type: 'boolean',
      default: false,
      description: 'Wait until the device is ready again after installing',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      let id = args.id as string | undefined;
      let app = args.app as string | undefined;
      if (id && !app && looksLikeApp(id)) [id, app] = [undefined, id];
      const binaryId = args['app-binary-id'] as string | undefined;
      if (Boolean(app) === Boolean(binaryId)) {
        throw new CliError('Give the build: a file path, an https URL, or --app-binary-id.');
      }

      const ctx = await context(args);
      id = await resolveSessionId(ctx.apiUrl, ctx.auth, id);
      const body = binaryId ? { binaryUploadId: binaryId } : await resolveApp(ctx, app!);
      ctx.progress(ui.running(`Installing on ${colors.highlight(id)}…`));
      const installed = await DeviceGateway.install(ctx.apiUrl, ctx.auth, id, body);
      let { session } = installed;
      if (args.wait) {
        ctx.progress(ui.running('Waiting for the device…'));
        session = await waitUntilUsable(ctx, id);
      }

      const appInfo: DeviceInstalledApp = installed.app;
      return {
        session,
        data: { app: appInfo },
        print() {
          logger.log(ui.success(`Installing ${appInfo.app_id ?? appInfo.binary_upload_id}`));
          logger.log(
            ui.branch(
              ui.fields([
                ['binary id', appInfo.binary_upload_id],
                ...(appInfo.app_id ? [['app id', appInfo.app_id] as [string, string]] : []),
                ['session', colors.highlight(session.id)],
              ]),
            ),
          );
          if (!args.wait) {
            logger.log(ui.note('The device installs it next. Commands answer "not ready" until it is done.'));
          }
        },
      };
    });
  },
});

/** Bundle ids and package names have dots; session ids never do. */
function looksLikeAppId(value: string): boolean {
  return value.includes('.');
}

const launchSub = defineCommand({
  meta: { name: 'launch', description: 'Launch an app: the installed one, or a bundle id / package name' },
  args: {
    ...commonArgs,
    id: idArg,
    appId: {
      type: 'positional',
      required: false,
      description: 'Bundle id or package name (default: the installed app)',
    },
    'clear-state': {
      type: 'boolean',
      default: false,
      description: "Clear the app's data before launching",
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      let id = args.id as string | undefined;
      let appId = args.appId as string | undefined;
      if (id && !appId && looksLikeAppId(id)) [id, appId] = [undefined, id];

      const ctx = await context(args);
      id = await resolveSessionId(ctx.apiUrl, ctx.auth, id);
      const { result, session } = await DeviceGateway.launch(ctx.apiUrl, ctx.auth, id, {
        ...(appId && { appId }),
        ...(args['clear-state'] ? { clearState: true } : {}),
      });
      return {
        session,
        data: { result } as { result: DeviceCommandResult },
        ...(!result.success && {
          failure: { code: null, message: result.error || 'The app did not launch.' },
        }),
        print() {
          logger.log(
            result.success
              ? ui.success(`Launched ${appId ?? 'the app'}`)
              : `${ui.statusSymbol('FAILED')} Launch failed`,
          );
          if (result.error) logger.log(colors.error(result.error));
        },
      };
    });
  },
});

const modelsSub = defineCommand({
  meta: { name: 'models', description: 'The devices a session can ask for' },
  args: {
    ...commonArgs,
    platform: { type: 'string', description: 'Only this platform: ios or android' },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const platform = validateEnum(args.platform as string | undefined, PLATFORMS, 'platform');
      const ctx = await context(args);
      const catalogue = await DeviceGateway.models(ctx.apiUrl, ctx.auth);
      const data: Partial<DeviceCatalogue> = platform ? { [platform]: catalogue[platform] } : catalogue;
      return {
        session: null,
        data,
        print() {
          for (const p of PLATFORMS) {
            const models = data[p];
            if (!models) continue;
            logger.log(ui.section(p === 'ios' ? 'iOS' : 'Android'));
            logger.log(
              ui.branch(
                ui.fields(
                  models.map((m) => [
                    m.default ? colors.bold(m.model) : m.model,
                    `${m.name}  ${colors.dim(`os ${m.os.join(', ')} (default ${m.default_os})`)}` +
                      (m.google_play ? colors.dim('  google play') : '') +
                      (m.default ? colors.dim('  default') : ''),
                  ]),
                ),
              ),
            );
          }
        },
      };
    });
  },
});

export const deviceCommand = defineCommand({
  meta: {
    name: 'device',
    description: 'Cloud devices you (or an AI agent) can lease, drive and release [beta]',
    // Left out of `dcd --help` until the /device/sessions API is in
    // production (Agent Devices plan, Phase 8). It works when called by name.
    hidden: true,
  },
  subCommands: {
    start: startSub,
    list: listSub,
    status: statusSub,
    stop: stopSub,
    install: installSub,
    launch: launchSub,
    models: modelsSub,
  },
});

