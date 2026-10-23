import { defineCommand } from 'citty';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolve as resolvePath } from 'node:path';

import { apiFlags } from '../config/flags/api.flags.js';
import { jsonFlag } from '../config/flags/output.flags.js';
import { DeviceApiError, DeviceGateway } from '../gateways/device-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import {
  type DeviceCatalogue,
  type DeviceCommandResult,
  type DeviceInstalledApp,
  type DeviceRunResponse,
  type DeviceScreenElement,
  type DeviceSession,
  ENDED_STATES,
  type StartDeviceSessionRequest,
} from '../types/domain/device-session.types.js';
import { platformOfAppFile, uploadLocalApp } from '../utils/app-upload.js';
import { refreshAuth, resolveAuth } from '../utils/auth.js';
import { openBrowser } from '../utils/browser.js';
import { uploadFlowBundle } from '../utils/device-bundle.js';
import {
  type DeviceArtifactFile,
  downloadArtifactFiles,
  fetchAllArtifacts,
  pendingArtifacts,
  pendingArtifactsWarning,
  planArtifactFiles,
} from '../utils/device-artifacts.js';
import { CliError, logger, validateEnum } from '../utils/cli.js';
import { resolveApiUrl } from '../utils/config-store.js';
import {
  deviceProgress,
  printSession,
  resolveSessionId,
  runDeviceCommand,
} from '../utils/device-output.js';
import { parseRunReport, printRunResult, runFailureMessage } from '../utils/device-run.js';
import { isUrl } from '../utils/expo.js';
import { colors, formatUrl } from '../utils/styling.js';
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

/**
 * Polling loops can outlast a `dcd login` access token (about an hour), so
 * they renew it before each call. An API key is returned unchanged.
 */
async function freshAuth(ctx: Ctx): Promise<AuthContext> {
  ctx.auth = await refreshAuth(ctx.auth);
  return ctx.auth;
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
    const { session } = await DeviceGateway.status(ctx.apiUrl, await freshAuth(ctx), id);
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
 * Poll until the device has finished installing `binaryId`: the session
 * block's `install.status` leaves `installing`. The session is usable
 * throughout (it stays ready while a new build installs), so waiting on the
 * state alone returned too early. An API without `install` returns at once.
 */
async function waitForInstall(ctx: Ctx, id: string, binaryId: string): Promise<DeviceSession> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const { session } = await DeviceGateway.status(ctx.apiUrl, await freshAuth(ctx), id);
    const install = session.install;
    if (ENDED_STATES.includes(session.state)) {
      throw new DeviceApiError(
        `Device session ${id} ended while installing (${session.release_reason ?? session.state}).`,
        410,
        'LIVE_SESSION_ENDED',
        session,
      );
    }

    // Done, failed, superseded by another install, or an API too old to say.
    if (!install || install.binary_upload_id !== binaryId || install.status !== 'installing') {
      return session;
    }

    if (Date.now() >= deadline) {
      throw new DeviceApiError(
        `Timed out after ${WAIT_TIMEOUT_MS / 60_000} minutes waiting for the install on ${id}. It may still finish: check it with \`dcd device status ${id}\`.`,
        408,
        null,
        session,
      );
    }

    await sleep(WAIT_POLL_MS);
  }
}

/** A failed install as a command failure (exit 2); the session stays open. */
function installFailure(session: DeviceSession): { code: null; message: string } | undefined {
  if (session.install?.status !== 'failed') return undefined;
  return {
    code: null,
    message: `The app could not be installed: ${session.install.error ?? 'unknown error'} Session ${session.id} is still open.`,
  };
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

/**
 * The platform a `--model` belongs to, from GET /device/models. Matches the
 * model id (iphone-16) or its name (iPhone 16), ignoring case. Unknown, or on
 * both platforms: a usage error that says to pass --platform.
 */
export function platformOfModel(catalogue: DeviceCatalogue, model: string): 'android' | 'ios' {
  const wanted = model.trim().toLowerCase();
  const found = PLATFORMS.filter((p) =>
    (catalogue[p] ?? []).some((m) => m.model.toLowerCase() === wanted || m.name.toLowerCase() === wanted),
  );
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw new CliError(
      `Unknown model "${model}". See \`dcd device models\` for the list, or pass --platform.`,
    );
  }

  throw new CliError(`"${model}" is a model on both iOS and Android. Pass --platform ios or --platform android.`);
}

const startSub = defineCommand({
  meta: { name: 'start', description: 'Start a device session' },
  args: {
    ...commonArgs,
    platform: {
      type: 'string',
      description: 'ios or android. Optional with --model or --app, which imply it',
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

      const model = args.model as string | undefined;
      const appPlatform = app && !isUrl(app) ? platformOfAppFile(app) : undefined;
      let platform =
        validateEnum(args.platform as string | undefined, PLATFORMS, 'platform') ?? appPlatform;
      if (!platform && !model) {
        throw new CliError('Pass --platform ios or android, or a --model or --app that says which.');
      }

      const ctx = await context(args);
      if (!platform) {
        platform = platformOfModel(await DeviceGateway.models(ctx.apiUrl, ctx.auth), model!);
      }

      if (appPlatform && appPlatform !== platform) {
        throw new CliError(`${app} is a build for ${appPlatform}, not ${platform}.`);
      }

      if (args['google-play'] && platform !== 'android') {
        throw new CliError('--google-play is only for Android.');
      }

      const resolved = app ? await resolveApp(ctx, app) : undefined;
      const uploadedId =
        binaryId ?? (resolved && 'binaryUploadId' in resolved ? resolved.binaryUploadId : undefined);

      const body: StartDeviceSessionRequest = {
        platform,
        clientLabel: (args.name as string | undefined) || DEFAULT_CLIENT_LABEL,
        ...(uploadedId && { binaryUploadId: uploadedId }),
        ...(model ? { model } : {}),
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
      let installedId: string | undefined;
      try {
        if (resolved && 'url' in resolved) {
          ctx.progress(ui.running('Installing the app from its URL…'));
          const fromUrl = await DeviceGateway.install(ctx.apiUrl, ctx.auth, session.id, resolved);
          session = fromUrl.session;
          installedId = fromUrl.app.binary_upload_id;
        }

        if (args.wait) {
          ctx.progress(ui.running('Waiting for the device…'));
          session = await waitUntilUsable(ctx, session.id);
          const expected = installedId ?? uploadedId;
          if (expected) {
            ctx.progress(ui.running('Waiting for the app to install…'));
            session = await waitForInstall(ctx, session.id, expected);
          }
        }
      } catch (error) {
        if (error instanceof DeviceApiError && error.code === 'LIVE_SESSION_ENDED') throw error;
        const message = `${error instanceof Error ? error.message : String(error)} Session ${session.id} is still open: stop it with \`dcd device stop ${session.id}\`.`;
        if (error instanceof DeviceApiError) {
          throw new DeviceApiError(message, error.status, error.code, error.session ?? session);
        }

        throw new DeviceApiError(message, 500, null, session);
      }

      const startFailure = args.wait ? installFailure(session) : undefined;
      return {
        session,
        data: { binary_upload_id: installedId ?? uploadedId ?? null },
        ...(startFailure && { failure: startFailure }),
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
        session: undefined,
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
          session: undefined,
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
        ctx.progress(ui.running('Waiting for the app to install…'));
        session = await waitForInstall(ctx, id, installed.app.binary_upload_id);
      }

      const appInfo: DeviceInstalledApp = installed.app;
      const failure = args.wait ? installFailure(session) : undefined;
      return {
        session,
        data: { app: appInfo },
        ...(failure && { failure }),
        print() {
          if (failure) {
            logger.log(`${ui.statusSymbol('FAILED')} ${failure.message}`);
            return;
          }

          logger.log(
            ui.success(`${args.wait ? 'Installed' : 'Installing'} ${appInfo.app_id ?? appInfo.binary_upload_id}`),
          );
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
        session: undefined,
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

const inspectSub = defineCommand({
  meta: { name: 'inspect', description: 'The screen as compact JSON: each element with text, an id or a label' },
  args: { ...commonArgs, id: idArg },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const { screen, session } = await DeviceGateway.inspect(ctx.apiUrl, ctx.auth, id);
      return {
        session,
        data: { screen },
        print() {
          logger.log(
            ui.section(
              `Screen ${screen.width}x${screen.height}, ${screen.elements.length} elements` +
                (screen.fresh ? '' : colors.dim(' (no new frame; this is the latest)')),
            ),
          );
          logger.log(ui.branch(screen.elements.map((el) => formatElement(el))));
        },
      };
    });
  },
});

/** One element on one line: what to target it by, then its bounds. */
export function formatElement(el: DeviceScreenElement): string {
  const parts: string[] = [];
  if (el.txt) parts.push(`"${el.txt}"`);
  if (el.a11y && el.a11y !== el.txt) parts.push(`a11y:"${el.a11y}"`);
  if (el.rid) parts.push(`id:${el.rid}`);
  if (el.hint) parts.push(`hint:"${el.hint}"`);
  return `${parts.join('  ')}  ${colors.dim(el.b)}`;
}

/** `data:image/jpeg;base64,...` to bytes and a file extension. */
export function decodeDataUrl(dataUrl: string): { bytes: Buffer; ext: string } {
  const match = /^data:image\/([a-z]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('The API returned a screenshot in an unexpected format.');
  return { bytes: Buffer.from(match[2], 'base64'), ext: match[1] === 'jpeg' ? 'jpg' : match[1] };
}

const screenshotSub = defineCommand({
  meta: { name: 'screenshot', description: 'Save a screenshot of the device' },
  args: {
    ...commonArgs,
    id: idArg,
    output: {
      type: 'string',
      alias: ['o'],
      description: 'Where to save it (default: ./<session>-<time>.jpg)',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const { screenshot, session } = await DeviceGateway.screenshot(ctx.apiUrl, ctx.auth, id);
      const { bytes, ext } = decodeDataUrl(screenshot.data_url);
      const file =
        (args.output as string | undefined) ||
        `${session.id}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.${ext}`;
      writeFileSync(file, bytes);
      const filePath = resolvePath(file);
      return {
        session,
        data: { path: filePath, captured_at: screenshot.captured_at, fresh: screenshot.fresh },
        print() {
          logger.log(ui.success(`Saved ${filePath}`));
          if (!screenshot.fresh) logger.log(ui.note('No new frame came in time; this is the latest.'));
        },
      };
    });
  },
});

function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/** `--env KEY=VALUE`, given once or several times. */
export function parseEnvFlags(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === false) return undefined;
  const items = (Array.isArray(value) ? value : [value]).map(String);
  const env: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new CliError(`--env takes KEY=VALUE, got "${item}".`);
    env[item.slice(0, eq)] = item.slice(eq + 1);
  }

  return env;
}

/** Wait for a flow that outlasted the API's own wait. */
async function waitForCommand(ctx: Ctx, id: string, commandId: string): Promise<DeviceRunResponse> {
  let last = '';
  for (;;) {
    await sleep(WAIT_POLL_MS);
    const response = await DeviceGateway.command(ctx.apiUrl, await freshAuth(ctx), id, commandId);
    if (response.status !== 'running') return response;
    const line = `still running (${response.session.state})`;
    if (line !== last) {
      last = line;
      ctx.progress(`   ${colors.dim(line)}`);
    }
  }
}

const runSub = defineCommand({
  meta: { name: 'run', description: 'Run a Maestro flow (or a directory of flows) on the device, and wait for the result' },
  args: {
    ...commonArgs,
    id: idArg,
    flow: {
      type: 'positional',
      required: false,
      description: 'A flow file (.yaml), or a directory of flows (uploaded as a bundle)',
    },
    yaml: {
      type: 'string',
      description: 'The flow inline, instead of a file',
    },
    entry: {
      type: 'string',
      description: 'With a directory: the one flow to run, as a path inside it (default: all of them)',
    },
    env: {
      type: 'string',
      description: 'A variable for the flow, KEY=VALUE, used as ${KEY}. Repeatable. Sent sealed, never stored in plain text',
    },
  },
  async run({ args, rawArgs }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      let id = args.id as string | undefined;
      let flow = args.flow as string | undefined;
      if (id && !flow && (/\.ya?ml$/i.test(id) || isDirectory(id))) [id, flow] = [undefined, id];
      const inline = recoverFlagValue('--yaml', args.yaml as string | undefined, rawArgs);
      if (Boolean(flow) === Boolean(inline)) {
        throw new CliError('Give a flow file, a directory of flows, or --yaml: one of the three.');
      }

      const dir = flow && isDirectory(flow) ? flow : undefined;
      const entry = args.entry as string | undefined;
      if (entry && !dir) throw new CliError('--entry picks a flow inside a directory; give a directory.');
      if (entry && (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..'))) {
        throw new CliError('--entry is a path inside the directory, e.g. flows/login.yaml.');
      }

      let yaml = inline;
      if (flow && !dir) {
        try {
          yaml = readFileSync(flow, 'utf8');
        } catch (error) {
          throw new CliError(`Could not read ${flow}: ${(error as Error).message}`);
        }
      }

      const repeated = collectFlagValues('--env', rawArgs);
      const env = parseEnvFlags(repeated.length > 0 ? repeated : args.env);
      const ctx = await context(args);
      id = await resolveSessionId(ctx.apiUrl, ctx.auth, id);

      let body: Parameters<typeof DeviceGateway.run>[3];
      if (dir) {
        ctx.progress(ui.running(`Uploading the flows in ${colors.highlight(dir)}…`));
        const bundle = await uploadFlowBundle({ apiUrl: ctx.apiUrl, auth: ctx.auth, dir, log: ctx.progress });
        ctx.progress(ui.success(`Uploaded ${bundle.files} files`));
        body = {
          flowUploadId: bundle.id,
          ...(entry && { flow: entry.split(path.sep).join('/') }),
          ...(env && { env }),
        };
      } else {
        body = { yaml: yaml!, ...(env && { env }) };
      }

      ctx.progress(ui.running(`Running ${entry ?? flow ?? 'the flow'} on ${colors.highlight(id)}…`));
      let response = await DeviceGateway.run(ctx.apiUrl, ctx.auth, id, body);
      if (response.status === 'running') response = await waitForCommand(ctx, id, response.command_id);

      const result = response.result ?? { success: false };
      const passed = response.status === 'passed';
      return {
        session: response.session,
        data: { command_id: response.command_id, status: response.status, result },
        ...(!passed && {
          failure: { code: null, message: runFailureMessage(result, parseRunReport(result)) },
        }),
        print() {
          printRunResult(logger.log, passed, result, entry ?? (flow ? path.basename(flow) : 'flow'));
        },
      };
    });
  },
});

/** Every value of a repeatable flag; citty keeps only the last one. */
export function collectFlagValues(flag: string, rawArgs: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === flag && i + 1 < rawArgs.length) values.push(rawArgs[++i]);
    else if (rawArgs[i].startsWith(`${flag}=`)) values.push(rawArgs[i].slice(flag.length + 1));
  }

  return values;
}

/**
 * citty drops a string flag's value when it starts with `-`, as a flow's
 * first command does (`--yaml "- launchApp"`). Read it from argv instead.
 */
export function recoverFlagValue(
  flag: string,
  parsed: string | undefined,
  rawArgs: string[],
): string | undefined {
  if (parsed && parsed.trim()) return parsed;
  const eq = rawArgs.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = rawArgs.indexOf(flag);
  if (idx !== -1 && idx + 1 < rawArgs.length) return rawArgs[idx + 1];
  return parsed;
}

/**
 * The lines of `next` that `prev` has not shown. Each fetch is the log's
 * last N lines, so the overlap is the longest end of `prev` that `next`
 * starts with. No overlap: everything in `next` is new.
 */
export function newLogLines(prev: string[], next: string[]): string[] {
  for (let k = Math.min(prev.length, next.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== next[i]) {
        same = false;
        break;
      }
    }

    if (same) return next.slice(k);
  }

  return next;
}

const LOGS_FOLLOW_MS = 3000;

const logsSub = defineCommand({
  meta: { name: 'logs', description: "The installed app's recent device log lines" },
  args: {
    ...commonArgs,
    id: idArg,
    lines: { type: 'string', default: '200', description: 'How many lines, up to 2000' },
    follow: {
      type: 'boolean',
      alias: ['f'],
      default: false,
      description: 'Keep printing new lines until the session ends (not with --json)',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    if (args.follow && json) {
      await runDeviceCommand(json, async () => {
        throw new CliError('--follow prints a stream of lines, so it cannot be used with --json.');
      });
      return;
    }

    const lines = Number.parseInt(String(args.lines), 10);
    await runDeviceCommand(json, async () => {
      if (!Number.isInteger(lines) || lines < 1) throw new CliError('--lines must be a whole number.');
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const first = await DeviceGateway.logs(ctx.apiUrl, ctx.auth, id, lines);
      if (!args.follow) {
        return {
          session: first.session,
          data: { logs: first.logs },
          print() {
            if (first.logs.lines.length === 0) {
              logger.log(ui.info(first.logs.source === 'none' ? 'No app installed yet, so no app logs.' : 'No log lines yet.'));
              return;
            }

            for (const line of first.logs.lines) logger.log(line);
          },
        };
      }

      // --follow: print as lines arrive. Ends when the session does.
      for (const line of first.logs.lines) logger.log(line);
      let shown = first.logs.lines;
      let { session } = first;
      for (;;) {
        await sleep(LOGS_FOLLOW_MS);
        try {
          const next = await DeviceGateway.logs(ctx.apiUrl, await freshAuth(ctx), id, lines);
          for (const line of newLogLines(shown, next.logs.lines)) logger.log(line);
          shown = next.logs.lines;
          session = next.session;
        } catch (error) {
          if (error instanceof DeviceApiError && error.code === 'LIVE_SESSION_ENDED') {
            return {
              session: error.session ?? session,
              data: null,
              print() {
                logger.log(ui.info(`Session ${id} has ended.`));
              },
            };
          }

          throw error;
        }
      }
    });
  },
});

const openSub = defineCommand({
  meta: { name: 'open', description: "Open the session's live monitor in the browser" },
  args: { ...commonArgs, id: idArg },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const { session } = await DeviceGateway.status(ctx.apiUrl, ctx.auth, id);
      // Only a person at a terminal gets a browser; a script gets the URL.
      const opened = interactive(json) && openBrowser(session.monitor_url);
      return {
        session,
        data: { url: session.monitor_url, opened },
        print() {
          logger.log(opened ? ui.success('Opened the monitor') : ui.info('The monitor:'));
          logger.log(ui.branch([formatUrl(session.monitor_url)]));
        },
      };
    });
  },
});

interface ArtifactsData {
  /** Where they were saved; null with --links. */
  dir: null | string;
  files: DeviceArtifactFile[];
  failed: { file: string; reason: string }[];
  /** What is still uploading after the session ended; see pendingArtifacts. */
  pending: ('logs' | 'recording')[];
  /** Says so in words, or null. */
  warning: null | string;
}

const artifactsSub = defineCommand({
  meta: {
    name: 'artifacts',
    description: 'Download what a session left behind: its video, device log, and the screen after each action',
  },
  args: {
    ...commonArgs,
    id: idArg,
    output: {
      type: 'string',
      alias: ['o'],
      description: 'Directory to save them in (default: ./<session>-artifacts)',
    },
    links: {
      type: 'boolean',
      default: false,
      description: 'List the download links instead of downloading (they expire after a while)',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand<ArtifactsData>(json, async () => {
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const { pages, session } = await fetchAllArtifacts(ctx.apiUrl, ctx.auth, id);
      const files = planArtifactFiles(pages);
      const pending = pendingArtifacts(pages);
      const warning = pendingArtifactsWarning(pending);
      const printWarning = () => {
        if (warning) logger.log(ui.warn(warning));
      };

      if (args.links) {
        return {
          session,
          data: { dir: null, files, failed: [], pending, warning },
          print() {
            if (files.length === 0) {
              logger.log(ui.info('This session has no artifacts yet.'));
              printWarning();
              return;
            }

            logger.log(ui.section(`Artifacts (${files.length})`));
            logger.log(ui.branch(ui.fields(files.map((f) => [f.file, f.url ? formatUrl(f.url) : colors.dim('no link')]))));
            printWarning();
          },
        };
      }

      const dir = resolvePath((args.output as string | undefined) || `${session.id}-artifacts`);
      if (files.length > 0) ctx.progress(ui.running(`Downloading ${files.length} files to ${dir}…`));
      const failed = await downloadArtifactFiles(dir, files);
      const saved = files.length - failed.length;
      return {
        session,
        data: { dir, files, failed, pending, warning },
        ...(failed.length > 0 && {
          failure: {
            code: null,
            message: `${failed.length} of ${files.length} files could not be downloaded: ${failed.map((f) => `${f.file} (${f.reason})`).join(', ')}`,
          },
        }),
        print() {
          if (files.length === 0) {
            logger.log(ui.info('This session has no artifacts yet.'));
            printWarning();
            return;
          }

          logger.log(ui.success(`Saved ${saved} of ${files.length} files to ${dir}`));
          for (const f of failed) logger.log(ui.warn(`${f.file}: ${f.reason}`));
          printWarning();
          if (!ENDED_STATES.includes(session.state)) {
            logger.log(ui.note('The session is still open: its video and log are saved when it ends.'));
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
    inspect: inspectSub,
    screenshot: screenshotSub,
    run: runSub,
    logs: logsSub,
    open: openSub,
    artifacts: artifactsSub,
  },
});

