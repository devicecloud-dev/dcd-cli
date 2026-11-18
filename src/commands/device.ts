import { defineCommand } from 'citty';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolve as resolvePath } from 'node:path';

import { apiFlags } from '../config/flags/api.flags.js';
import { jsonFlag } from '../config/flags/output.flags.js';
import {
  DeviceApiError,
  DeviceGateway,
  START_RECOVERY_WINDOW_MS,
  startOutcomeUnknown,
} from '../gateways/device-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import {
  DEVICE_KEYS,
  type DeviceActionRequest,
  type DeviceCatalogue,
  type DeviceCommandResult,
  type DeviceHumanStatus,
  type DeviceInstalledApp,
  type DevicePoint,
  type DeviceRunResponse,
  type DeviceScreenElement,
  type DeviceSession,
  type DeviceSwipeDirection,
  ENDED_STATES,
  LOG_LEVELS,
  type StartDeviceSessionRequest,
  SWIPE_DIRECTIONS,
} from '../types/domain/device-session.types.js';
import { platformOfAppFile, platformOfAppUrl, uploadLocalApp } from '../utils/app-upload.js';
import { refreshAuth, resolveAuth } from '../utils/auth.js';
import { openBrowser } from '../utils/browser.js';
import { bundlePath, flowFileBundle, uploadFlowBundle } from '../utils/device-bundle.js';
import {
  type DeviceArtifactFile,
  downloadArtifactFiles,
  downloadFile,
  fetchAllArtifacts,
  pendingArtifacts,
  pendingArtifactsWarning,
  planArtifactFiles,
} from '../utils/device-artifacts.js';
import { CliError, logger, validateEnum } from '../utils/cli.js';
import { resolveApiUrl } from '../utils/config-store.js';
import { strictFlags } from '../utils/device-flags.js';
import {
  checkSessionId,
  DEVICE_EXIT,
  deviceProgress,
  humanFields,
  printable,
  printSession,
  printWarnings,
  resolveRecentSessionId,
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
/** Longer than the API's own queue timeout, so that one is what ends a wait. */
const WAIT_TIMEOUT_MS = 20 * 60 * 1000;
/** The longest a session can run (60 minutes), and a little more: a flow can't run past its session. */
const MAX_SESSION_MS = 65 * 60 * 1000;

/**
 * How the waits poll. `retryMs` is how long a wait keeps asking through
 * failed requests before it gives up, and `retryBaseMs` the first pause
 * between tries (doubled each time, up to 15s). `runGraceMs` is how long a
 * wait for a flow goes on past its session's maximum duration, for the API
 * to end the session. Changed by tests only.
 */
export const deviceTiming = { pollMs: 2000, retryBaseMs: 2000, retryMs: 90_000, runGraceMs: 60_000 };
/** States in which a session takes commands. */
const USABLE_STATES = new Set(['active', 'needs_human', 'ready']);

/** Every `dcd device` subcommand takes these. */
const commonArgs = { ...apiFlags, json: jsonFlag } as const;

const idArg = {
  type: 'positional',
  required: false,
  description: 'Session id, e.g. brave-teal-otter. Optional when you have exactly one open session.',
} as const;

/**
 * For the commands that change a session: one someone else started (another
 * person or another API key) is refused with LIVE_NOT_YOURS unless this is
 * given. A teammate's agent may be using it.
 */
const forceArg = {
  type: 'boolean',
  default: false,
  description: 'Change a session someone else started (another person or API key)',
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
 * A failure worth asking again: no answer came (a dropped connection, an
 * unreadable reply), or the API or a proxy in front of it was busy or briefly
 * down. A refusal (a 4xx other than 408 and 429) is final.
 */
export function transientFailure(error: unknown): boolean {
  if (error instanceof DeviceApiError) return [408, 429, 500, 502, 503, 504].includes(error.status);
  return !(error instanceof CliError);
}

/**
 * One request of a wait, asked again while it fails for a reason that passes
 * (transientFailure), for up to deviceTiming.retryMs. A wait of many minutes
 * must not end, and lose what it was waiting for, on one failed poll.
 */
async function pollOnce<T>(ctx: Ctx, call: (auth: AuthContext) => Promise<T>): Promise<T> {
  const giveUpAt = Date.now() + deviceTiming.retryMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call(await freshAuth(ctx));
    } catch (error) {
      if (!transientFailure(error) || Date.now() >= giveUpAt) throw error;
      const asked = error instanceof DeviceApiError ? Number(error.details.retry_after_s) : Number.NaN;
      const pause =
        Number.isFinite(asked) && asked > 0
          ? Math.min(asked * 1000, 60_000)
          : Math.min(deviceTiming.retryBaseMs * 2 ** attempt, 15_000);
      const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
      ctx.progress(`   ${colors.dim(`a request failed (${reason}); asking again in ${Math.ceil(pause / 1000)}s`)}`);
      await sleep(pause);
    }
  }
}

/** A session that has ended, as the error that exits 4. */
function sessionEnded(id: string, session: DeviceSession, while_: string, details: Record<string, unknown> = {}) {
  return new DeviceApiError(
    `Device session ${id} ended ${while_} (${session.release_reason ?? session.state}). An ended session is final: start a new one.`,
    410,
    'LIVE_SESSION_ENDED',
    session,
    false,
    details,
  );
}

/**
 * Poll until the session takes commands. Reports each change of state (and
 * queue position) as progress. A session that ends while waiting is exit 4.
 */
async function waitUntilUsable(ctx: Ctx, id: string): Promise<DeviceSession> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last = '';
  for (;;) {
    const { session } = await pollOnce(ctx, (auth) => DeviceGateway.status(ctx.apiUrl, auth, id));
    if (USABLE_STATES.has(session.state)) return session;
    if (ENDED_STATES.includes(session.state)) throw sessionEnded(id, session, 'while waiting for it to be ready');

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

    await sleep(deviceTiming.pollMs);
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
    const { session } = await pollOnce(ctx, (auth) => DeviceGateway.status(ctx.apiUrl, auth, id));
    const install = session.install;
    if (ENDED_STATES.includes(session.state)) throw sessionEnded(id, session, 'while installing');

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

    await sleep(deviceTiming.pollMs);
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

/**
 * A start that got no answer, or a proxy's 5xx in the API's place, may still
 * have made a session, which is billed while it runs. Someone who just runs
 * `dcd device start` again would have two. So name the sessions started in
 * the last couple of minutes, and say to check before starting again.
 */
async function failedStartError(ctx: Ctx, error: unknown): Promise<DeviceApiError> {
  const reason = error instanceof Error ? error.message : String(error);
  const status = error instanceof DeviceApiError ? error.status : 502;
  const head =
    'Starting the session failed, but the request may still have started a session, and a session is billed while it runs.';
  // What to do first: a network error's message runs to a dozen lines.
  const failed = (advice: string, session: DeviceSession | null = null) =>
    new DeviceApiError(`${head} ${advice}\n\nThe error: ${reason}`, status, null, session);
  const minutes = START_RECOVERY_WINDOW_MS / 60_000;
  const recent = await DeviceGateway.recentlyStarted(ctx.apiUrl, ctx.auth);
  if (recent === null) {
    return failed('Check for one with `dcd device list` before you start another.');
  }

  if (recent.length === 0) {
    return failed(`No session was started in the last ${minutes} minutes, so it is safe to start one again.`);
  }

  const listed = recent
    .map((s) => `${s.id} (${s.client_label ?? 'no label'}, ${s.state}, started ${s.created_at})`)
    .join(', ');
  return failed(
    `Open sessions started in the last ${minutes} minutes: ${listed}. If one is yours, use it instead of starting another; check it with \`dcd device status <id>\`. Otherwise stop it with \`dcd device stop <id>\`.`,
    recent.length === 1 ? recent[0] : null,
  );
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

/**
 * The "Next steps" `dcd device start` prints. They follow the session: a
 * device that isn't ready yet can't be inspected, so that comes first, and
 * a session with no app gets the install step.
 */
export function startNextSteps(session: DeviceSession, hasApp: boolean): [string, string][] {
  const { id } = session;
  const steps: [string, string][] = [];
  if (!USABLE_STATES.has(session.state)) {
    steps.push(['check it is ready', `dcd device status ${id}`]);
  }

  if (!hasApp) steps.push(['install an app', `dcd device install ${id} <app>`]);
  steps.push(
    ['inspect the screen', `dcd device inspect ${id}`],
    ['run a flow', `dcd device run ${id} flow.yaml`],
    ['stop', `dcd device stop ${id}`],
    ['all commands', 'dcd device --help'],
  );
  return steps;
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
      // `--app "$BUILD"` with BUILD unset would start a billed session with no app.
      for (const [flag, value] of [['app', app], ['app-binary-id', binaryId]] as const) {
        if (value !== undefined && !String(value).trim()) {
          throw new CliError(`--${flag} is empty (a variable that was not set?). Give the build, or leave the flag out.`);
        }
      }

      if (app && binaryId) throw new CliError('Pass --app or --app-binary-id, not both.');

      const model = args.model as string | undefined;
      const appPlatform = app ? (isUrl(app) ? platformOfAppUrl(app) : platformOfAppFile(app)) : undefined;
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
      let session: DeviceSession;
      try {
        ({ session } = await DeviceGateway.start(ctx.apiUrl, ctx.auth, body));
      } catch (error) {
        if (!startOutcomeUnknown(error)) throw error;
        throw await failedStartError(ctx, error);
      }

      ctx.progress(ui.success(`Session ${session.id} started`));
      // Under --json nothing else is printed until the wait ends, which can
      // be many minutes. A caller that gives up before then must still know
      // which session it started, to use or stop it.
      if (json && args.wait) {
        process.stderr.write(
          `Session ${session.id} started; waiting until it is ready. Stop it with \`dcd device stop ${session.id}\` if you stop waiting.\n`,
        );
      }

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
          const hasApp = Boolean(installedId ?? uploadedId);
          const steps = startNextSteps(session, hasApp);
          logger.log(ui.branch(ui.fields(steps.map(([label, cmd]) => [label, colors.highlight(cmd)]))));
          if (!USABLE_STATES.has(session.state)) {
            logger.log(ui.info('Next time, `dcd device start --wait` waits until the device is ready.'));
          }
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
                  printable([s.state, s.platform, s.model, s.client_label].filter(Boolean).join('  '), {
                    oneLine: true,
                  }),
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
  args: {
    ...commonArgs,
    id: idArg,
    wait: {
      type: 'boolean',
      default: false,
      description: 'Wait until the session is ready for commands and its app is installed (exit 4 if it ends first)',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      if (args.wait) {
        ctx.progress(ui.running(`Waiting for ${colors.highlight(id)}…`));
        const ready = await waitUntilUsable(ctx, id);
        if (ready.install?.status === 'installing') {
          ctx.progress(ui.running('Waiting for the app to install…'));
          await waitForInstall(ctx, id, ready.install.binary_upload_id);
        }
      }

      // The summary does not say whether a person handed the session back,
      // so ask. An API without the route (or a failure) just leaves it out.
      const [{ session }, human] = await Promise.all([
        DeviceGateway.status(ctx.apiUrl, ctx.auth, id),
        DeviceGateway.human(ctx.apiUrl, ctx.auth, id).then(
          (r) => r.human ?? null,
          () => null,
        ),
      ]);
      return {
        session,
        data: human ? { human } : null,
        print() {
          logger.log(ui.section('Device session'));
          printSession(session);
          if (human?.handed_back) {
            logger.log(
              ui.info(`A person handed it back${human.note ? `: ${printable(human.note, { oneLine: true })}` : ' (no note).'}`),
            );
          }

          // The API's own warning already says a person has control and how
          // to wait; only add ours when an older API leaves it out.
          const apiSaysWaiting = (session.warnings ?? []).some(
            (w) => w.startsWith('Waiting for a human') || w.startsWith('A person has control'),
          );
          if (human?.human_in_control && !apiSaysWaiting) {
            logger.log(ui.warn(`A person has control. Wait with \`dcd device human ${session.id} --wait\`.`));
          }
        },
      };
    });
  },
});

const stopSub = defineCommand({
  meta: { name: 'stop', description: 'Stop a session, or every open one of yours with --all' },
  args: {
    ...commonArgs,
    id: idArg,
    all: { type: 'boolean', default: false, description: 'Stop every open session of yours (with --force, everyone\'s)' },
    force: forceArg,
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      if (args.all) {
        if (args.id) throw new CliError('Pass a session id or --all, not both.');
        const { sessions } = await DeviceGateway.list(ctx.apiUrl, ctx.auth);
        // Yours, or every one with --force: another's may be a teammate's
        // agent at work. An API that does not say whose is read as before.
        const force = Boolean(args.force);
        const mine = sessions.filter((s) => force || !s.started_by || s.started_by.you);
        const others = sessions.filter((s) => !mine.includes(s));
        const stopped: DeviceSession[] = [];
        for (const s of mine) {
          stopped.push((await DeviceGateway.stop(ctx.apiUrl, ctx.auth, s.id, force)).session);
        }

        return {
          session: undefined,
          data: { left: others.map((s) => s.id), stopped },
          print() {
            logger.log(
              stopped.length === 0
                ? ui.info('No open device sessions of yours to stop.')
                : ui.success(`Stopped ${stopped.map((s) => s.id).join(', ')}`),
            );
            if (others.length > 0) {
              logger.log(
                ui.info(
                  `Left ${others.map((s) => s.id).join(', ')}, started by someone else. Add --force to stop those too.`,
                ),
              );
            }
          },
        };
      }

      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const { session } = await DeviceGateway.stop(ctx.apiUrl, ctx.auth, id, Boolean(args.force));
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
    force: forceArg,
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
      const installed = await DeviceGateway.install(ctx.apiUrl, ctx.auth, id, body, Boolean(args.force));
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

          printWarnings(session);
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
    force: forceArg,
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
      const { result, session } = await DeviceGateway.launch(
        ctx.apiUrl,
        ctx.auth,
        id,
        {
          ...(appId && { appId }),
          ...(args['clear-state'] ? { clearState: true } : {}),
        },
        Boolean(args.force),
      );
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
          if (result.error) logger.log(colors.error(printable(result.error)));
          printWarnings(session);
        },
      };
    });
  },
});

/**
 * Shared by the typed-action subcommands. It chose Maestro over the device's
 * direct path when a device session had two engines. It has one now, so the
 * flag is still taken, for scripts that pass it, and does nothing.
 */
const maestroArg = {
  type: 'boolean',
  default: false,
  description: 'Deprecated: has no effect. Device sessions have a single engine',
} as const;

/** A percentage of the screen from a flag value (`50` or `50%`), or a usage error. */
function percentArg(value: unknown, flag: string): number {
  const n = typeof value === 'number' ? value : Number(typeof value === 'string' ? value.trim().replace(/%$/, '') : value);
  if (typeof value === 'boolean' || value === '' || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new CliError(`--${flag} must be a number from 0 to 100 (a percentage of the screen).`, 1);
  }
  return n;
}

/** The longest a tap may wait for its target, as the API allows. */
const MAX_TAP_TIMEOUT_SECONDS = 60;

/** Seconds from a flag value, from 0 to `max`, or a usage error. Undefined when the flag was not given. */
function secondsArg(value: unknown, flag: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean' || value === '' || !Number.isFinite(n) || n < 0 || n > max) {
    throw new CliError(`--${flag} must be a number of seconds from 0 to ${max}.`, 1);
  }
  return n;
}

/** Decimal degrees from a flag value, within `limit` either way, or a usage error. */
function degreesArg(value: unknown, flag: string, limit: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (
    value === undefined ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.trim() === '') ||
    !Number.isFinite(n) ||
    n < -limit ||
    n > limit
  ) {
    throw new CliError(`--${flag} must be a number from -${limit} to ${limit} (decimal degrees).`, 1);
  }
  return n;
}

/** A link with a scheme and nothing a shell or a URL would split on. A session id has no colon. */
const LINK = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

/** "x,y" (percentages) from a flag value, or a usage error. */
function pointArg(value: unknown, flag: string): DevicePoint {
  const parts = typeof value === 'string' ? value.split(',') : [];
  if (parts.length !== 2) {
    throw new CliError(`--${flag} must be "x,y", percentages of the screen, e.g. --${flag} 50,80 or 50%,80%.`, 1);
  }
  return { x: percentArg(parts[0].trim(), flag), y: percentArg(parts[1].trim(), flag) };
}

/**
 * Send one typed action and print its outcome, the way `launch` does: exit 2
 * with the result when the device could not do it.
 *
 * `labels.done` and `labels.failed` are what a person reads, and may name
 * what was typed or opened. `labels.failure` is the failure's message when
 * the device gave no reason: fixed text, as it goes into the --json envelope
 * and the command's failure record, and must never carry typed text.
 */
async function performAction(
  args: Record<string, unknown>,
  id: string | undefined,
  body: DeviceActionRequest,
  labels: { done: string; failed: string; failure: string },
) {
  const ctx = await context(args);
  const sessionId = await resolveSessionId(ctx.apiUrl, ctx.auth, id);
  const { result, session } = await DeviceGateway.action(
    ctx.apiUrl,
    ctx.auth,
    sessionId,
    body,
    Boolean(args.force),
  );
  return {
    session,
    data: { result } as { result: DeviceCommandResult },
    ...(!result.success && {
      failure: { code: null, message: result.error || labels.failure },
    }),
    print() {
      logger.log(result.success ? ui.success(labels.done) : `${ui.statusSymbol('FAILED')} ${labels.failed}`);
      if (result.error) logger.log(colors.error(printable(result.error)));
      printWarnings(session);
    },
  };
}

const tapSub = defineCommand({
  meta: { name: 'tap', description: 'Tap an element by text or id, or a point on the screen' },
  args: {
    ...commonArgs,
    force: forceArg,
    id: idArg,
    text: { type: 'string', description: 'The element\'s text, label or hint, matched whole, ignoring case' },
    rid: { type: 'string', description: 'The element\'s resource id (rid in `dcd device inspect`)' },
    x: { type: 'string', description: 'With --y: a point, as percentages of the screen (0-100)' },
    y: { type: 'string', description: 'See --x' },
    timeout: {
      type: 'string',
      description: `With --text or --rid: seconds to wait for it to appear before failing (0-${MAX_TAP_TIMEOUT_SECONDS}, default 17; 0 looks once)`,
    },
    maestro: maestroArg,
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const targets = [
        args.text !== undefined,
        args.rid !== undefined,
        args.x !== undefined || args.y !== undefined,
      ].filter(Boolean).length;
      if (targets !== 1) {
        throw new CliError('tap takes exactly one target: --text, --rid, or --x and --y.', 1);
      }
      const timeoutSeconds = secondsArg(args.timeout, 'timeout', MAX_TAP_TIMEOUT_SECONDS);
      if (timeoutSeconds !== undefined && args.text === undefined && args.rid === undefined) {
        throw new CliError('tap --timeout goes with --text or --rid: a point has nothing to wait for.', 1);
      }
      const wait = timeoutSeconds === undefined ? {} : { timeoutSeconds };
      const body: DeviceActionRequest =
        args.text !== undefined
          ? { type: 'tap', text: String(args.text), ...wait }
          : args.rid !== undefined
            ? { type: 'tap', id: String(args.rid), ...wait }
            : { type: 'tap', x: percentArg(args.x, 'x'), y: percentArg(args.y, 'y') };
      const what =
        args.text !== undefined
          ? `"${String(args.text)}"`
          : args.rid !== undefined
            ? `id ${String(args.rid)}`
            : `${String(args.x)}%,${String(args.y)}%`;
      return performAction(args, args.id as string | undefined, body, {
        done: `Tapped ${what}`,
        failed: `Tap ${what} failed`,
        failure: 'The tap failed.',
      });
    });
  },
});

const typeSub = defineCommand({
  meta: { name: 'type', description: 'Type text into the focused field' },
  args: {
    ...commonArgs,
    force: forceArg,
    id: idArg,
    // Not `required`: citty would reject a missing value before runDeviceCommand,
    // and --json would then print the top-level error instead of the envelope.
    text: { type: 'string', description: 'What to type' },
    'text-stdin': {
      type: 'boolean',
      default: false,
      description:
        'Read the text from standard input instead of --text, so a secret stays out of the shell history and the process list',
    },
    sensitive: {
      type: 'boolean',
      default: false,
      description: 'The text is a secret: stored encrypted, never shown, masked in the output',
    },
    maestro: maestroArg,
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      if (args['text-stdin'] && args.text !== undefined) {
        throw new CliError('Pass --text or --text-stdin, not both.', 1);
      }

      const text = args['text-stdin'] ? await readStdinText() : String(args.text ?? '');
      if (!text) throw new CliError(args['text-stdin'] ? 'Standard input was empty: nothing to type.' : '--text must not be empty.', 1);
      const shown = args.sensitive ? `${text.length} character(s)` : `"${printable(text, { oneLine: true })}"`;
      return performAction(
        args,
        args.id as string | undefined,
        { type: 'type', text, ...(args.sensitive ? { sensitive: true } : {}) },
        { done: `Typed ${shown}`, failed: `Typing ${shown} failed`, failure: 'Typing failed.' },
      );
    });
  },
});

/**
 * The text piped to this command, without the one line break a shell's
 * `echo` adds. Refused at a terminal, where it would wait for typing.
 */
export async function readStdinText(stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<string> {
  if (stdin.isTTY) {
    throw new CliError(
      '--text-stdin reads the text from standard input: pipe it in, e.g. printf %s "$PASSWORD" | dcd device type --text-stdin --sensitive',
      1,
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const isDirection = (value: unknown): value is DeviceSwipeDirection =>
  typeof value === 'string' && (SWIPE_DIRECTIONS as readonly string[]).includes(value);

const swipeSub = defineCommand({
  meta: { name: 'swipe', description: 'Swipe up, down, left or right, or from one point to another' },
  args: {
    ...commonArgs,
    force: forceArg,
    id: idArg,
    direction: {
      type: 'positional',
      required: false,
      description: 'up, down, left or right (a swipe across most of the screen)',
    },
    from: { type: 'string', description: 'With --to: where the swipe starts, as "x,y" percentages' },
    to: { type: 'string', description: 'Where it ends, as "x,y" percentages' },
    maestro: maestroArg,
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      let id = args.id as string | undefined;
      let direction = args.direction as string | undefined;
      // `dcd device swipe up`: the one positional is the direction, not a session.
      if (id && !direction && isDirection(id)) [id, direction] = [undefined, id];
      const byPoints = args.from !== undefined || args.to !== undefined;
      if ((direction === undefined) === !byPoints) {
        throw new CliError('swipe takes a direction (up, down, left, right), or --from and --to.', 1);
      }
      let body: DeviceActionRequest;
      let what: string;
      if (direction !== undefined) {
        if (!isDirection(direction)) {
          throw new CliError(`direction must be one of ${SWIPE_DIRECTIONS.join(', ')}.`, 1);
        }
        body = { type: 'swipe', direction };
        what = direction;
      } else {
        body = { type: 'swipe', from: pointArg(args.from, 'from'), to: pointArg(args.to, 'to') };
        what = `${String(args.from)} to ${String(args.to)}`;
      }
      return performAction(args, id, body, {
        done: `Swiped ${what}`,
        failed: `Swipe ${what} failed`,
        failure: 'The swipe failed.',
      });
    });
  },
});

const pressKeySub = defineCommand({
  meta: { name: 'press-key', description: `Press a key: ${DEVICE_KEYS.join(', ')}` },
  args: {
    ...commonArgs,
    force: forceArg,
    id: idArg,
    key: { type: 'positional', required: false, description: `One of ${DEVICE_KEYS.join(', ')}` },
    maestro: maestroArg,
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      let id = args.id as string | undefined;
      let key = args.key as string | undefined;
      // `dcd device press-key back`: the one positional is the key, not a session.
      if (id && !key && (DEVICE_KEYS as readonly string[]).includes(id)) [id, key] = [undefined, id];
      if (!key || !(DEVICE_KEYS as readonly string[]).includes(key)) {
        throw new CliError(`key must be one of ${DEVICE_KEYS.join(', ')}.`, 1);
      }
      return performAction(
        args,
        id,
        { type: 'press_key', key },
        { done: `Pressed ${key}`, failed: `Press ${key} failed`, failure: 'The key press failed.' },
      );
    });
  },
});

const openLinkSub = defineCommand({
  meta: { name: 'open-link', description: 'Open a link on the device: a deep link into an app, or a web link' },
  args: {
    ...commonArgs,
    force: forceArg,
    id: idArg,
    // Not `required`, as with `type --text`: a missing link fails inside the envelope.
    url: {
      type: 'positional',
      required: false,
      description: 'The link with its scheme, e.g. myapp://path or https://example.com',
    },
    sensitive: {
      type: 'boolean',
      default: false,
      description: 'The link is a secret (it carries a token): stored encrypted, never shown',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      let id = args.id as string | undefined;
      let url = args.url as string | undefined;
      // `dcd device open-link myapp://path`: the one positional is the link, not a session.
      if (id && !url && id.includes(':')) [id, url] = [undefined, id];
      if (!url || !LINK.test(url)) {
        throw new CliError(
          'open-link takes a link with its scheme and no spaces, e.g. myapp://path or https://example.com.',
          1,
        );
      }
      const shown = args.sensitive ? 'a link' : url;
      return performAction(
        args,
        id,
        { type: 'open_link', url, ...(args.sensitive ? { sensitive: true } : {}) },
        { done: `Opened ${shown}`, failed: `Opening ${shown} failed`, failure: 'Opening the link failed.' },
      );
    });
  },
});

const setLocationSub = defineCommand({
  meta: { name: 'set-location', description: "Set the device's GPS position, in decimal degrees" },
  args: {
    ...commonArgs,
    force: forceArg,
    id: idArg,
    latitude: { type: 'string', description: 'Decimal degrees, north positive (-90 to 90)' },
    longitude: { type: 'string', description: 'Decimal degrees, east positive (-180 to 180)' },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      // South and west are negative. citty keeps a value that is a number, minus sign and all.
      const latitude = degreesArg(args.latitude, 'latitude', 90);
      const longitude = degreesArg(args.longitude, 'longitude', 180);
      return performAction(
        args,
        args.id as string | undefined,
        { type: 'set_location', latitude, longitude },
        {
          done: `Location set to ${latitude}, ${longitude}`,
          failed: 'Setting the location failed',
          failure: 'Setting the location failed.',
        },
      );
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
  args: {
    ...commonArgs,
    id: idArg,
    all: {
      type: 'boolean',
      default: false,
      description: 'Also list the keyboard keys and the System UI (status and navigation bars)',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const { screen, session } = await DeviceGateway.inspect(ctx.apiUrl, ctx.auth, id, Boolean(args.all));
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
          const notes: string[] = [];
          if (screen.keyboard_open) notes.push('A keyboard is open.');
          if (screen.hidden && (screen.hidden.keyboard > 0 || screen.hidden.system > 0)) {
            notes.push(
              `Left out ${screen.hidden.keyboard} keyboard and ${screen.hidden.system} System UI elements (--all shows them).`,
            );
          }

          if (notes.length > 0) logger.log(ui.note(notes.join(' ')));
          printWarnings(session);
        },
      };
    });
  },
});

/** One element on one line: what to target it by, then its bounds. */
export function formatElement(el: DeviceScreenElement): string {
  // An element's text is whatever the app or a web page shows: never let it
  // drive the terminal.
  const show = (value: string) => printable(value, { oneLine: true });
  const parts: string[] = [];
  if (el.txt) parts.push(`"${show(el.txt)}"`);
  if (el.a11y && el.a11y !== el.txt) parts.push(`a11y:"${show(el.a11y)}"`);
  if (el.rid) parts.push(`id:${show(el.rid)}`);
  if (el.hint) parts.push(`hint:"${show(el.hint)}"`);
  for (const state of ['checked', 'selected', 'focused'] as const) {
    if (el[state]) parts.push(state);
  }

  if (el.enabled === false) parts.push('disabled');
  return `${parts.join('  ')}  ${colors.dim(el.b)}`;
}

/** `data:image/jpeg;base64,...` to bytes and a file extension. */
export function decodeDataUrl(dataUrl: string): { bytes: Buffer; ext: string } {
  const match = /^data:image\/([a-z]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('The API returned a screenshot in an unexpected format.');
  return { bytes: Buffer.from(match[2], 'base64'), ext: match[1] === 'jpeg' ? 'jpg' : match[1] };
}

/** What `dcd device screenshot` reports: a JPEG frame, or with --full a PNG. */
type ScreenshotData = {
  bytes?: null | number;
  captured_at: null | string;
  fresh?: boolean;
  height?: null | number;
  path: string;
  width?: null | number;
};

const screenshotSub = defineCommand({
  meta: { name: 'screenshot', description: 'Save a screenshot of the device' },
  args: {
    ...commonArgs,
    id: idArg,
    output: {
      type: 'string',
      alias: ['o'],
      description: 'Where to save it (default: ./<session>-<time>.jpg, or .png with --full)',
    },
    full: {
      type: 'boolean',
      description:
        "A PNG at the device's own resolution, instead of the smaller JPEG frame (for baseline images). Takes a few seconds; a device running a flow takes it when the flow ends",
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand<ScreenshotData>(json, async () => {
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      if (args.full) {
        const { screenshot, session } = await DeviceGateway.fullScreenshot(ctx.apiUrl, ctx.auth, id);
        const file =
          (args.output as string | undefined) ||
          `${session.id}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.png`;
        await downloadFile(screenshot.url, file);
        const filePath = resolvePath(file);
        const size = screenshot.width && screenshot.height ? `${screenshot.width}x${screenshot.height}` : null;
        return {
          session,
          data: {
            path: filePath,
            captured_at: screenshot.captured_at,
            width: screenshot.width,
            height: screenshot.height,
            bytes: screenshot.bytes,
          },
          print() {
            logger.log(ui.success(`Saved ${filePath}${size ? ` (${size})` : ''}`));
            printWarnings(session);
          },
        };
      }

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
          printWarnings(session);
        },
      };
    });
  },
});

function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/**
 * `--env-file`: KEY=VALUE lines, as a .env file has them. Blank lines and
 * `#` comments are skipped, `export ` is allowed, and one pair of quotes
 * around a value is removed. A bad line is named by its number only: the
 * line may hold a secret.
 */
export function parseEnvFile(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new CliError(`Could not read --env-file ${file}: ${(error as Error).message}`);
  }

  const env: Record<string, string> = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const pair = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const eq = pair.indexOf('=');
    const key = eq > 0 ? pair.slice(0, eq).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CliError(`--env-file ${file}, line ${index + 1}: expected KEY=VALUE.`);
    }

    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
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

/** The latest a flow can still be running: its session's maximum duration, and a little time for the API to end it. */
function runDeadline(session: DeviceSession, now = Date.now()): number {
  const left = session.time_remaining_s;
  return typeof left === 'number' && left >= 0 ? now + left * 1000 + deviceTiming.runGraceMs : now + MAX_SESSION_MS;
}

/**
 * Wait for a flow that outlasted the API's own wait. It ends with the flow,
 * or with the session: a flow can't outlive its session, so one that ends
 * (exit 4), or runs past its maximum duration, stops the wait.
 */
async function waitForCommand(ctx: Ctx, id: string, first: DeviceRunResponse): Promise<DeviceRunResponse> {
  const commandId = first.command_id;
  let response = first;
  let deadline = runDeadline(first.session);
  let last = '';
  for (;;) {
    if (response.status !== 'running') return response;
    const { session } = response;
    if (ENDED_STATES.includes(session.state)) {
      throw sessionEnded(id, session, 'before the flow finished', { command_id: commandId });
    }

    if (Date.now() >= deadline) {
      throw new DeviceApiError(
        `Gave up waiting for the flow: session ${id} has run past its maximum duration, yet still says ${session.state}. Check it with \`dcd device status ${id}\`.`,
        408,
        null,
        session,
        false,
        { command_id: commandId },
      );
    }

    const line = `still running (${session.state})`;
    if (line !== last) {
      last = line;
      ctx.progress(`   ${colors.dim(line)}`);
    }

    await sleep(deviceTiming.pollMs);
    response = await pollOnce(ctx, (auth) => DeviceGateway.command(ctx.apiUrl, auth, id, commandId));
    deadline = Math.min(deadline, runDeadline(response.session));
  }
}

/**
 * An error from waiting on a flow, with the flow's command id kept: the
 * flow may still be running, and the id is how to find out.
 */
function withCommandId(error: unknown, id: string, commandId: string): DeviceApiError {
  if (error instanceof DeviceApiError && error.details.command_id) return error;
  const message = `${error instanceof Error ? error.message : String(error)} The flow may still be running on ${id}: its command id is ${commandId}.`;
  if (error instanceof DeviceApiError) {
    return new DeviceApiError(message, error.status, error.code, error.session, error.fromApi, {
      ...error.details,
      command_id: commandId,
    });
  }

  return new DeviceApiError(message, 502, null, null, false, { command_id: commandId });
}

const runSub = defineCommand({
  meta: {
    name: 'run',
    description:
      'Run a Maestro flow (or a directory of flows) on the device, and wait for the result. ' +
      'A device session runs the common Maestro commands and no flow scripts (runScript, evalScript)',
  },
  args: {
    ...commonArgs,
    force: forceArg,
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
      description:
        'A variable for the flow, KEY=VALUE, used as ${KEY}. Repeatable. Stored encrypted, never shown, and masked in the output. A value given here is in your shell history: use --env-file for secrets',
    },
    'env-file': {
      type: 'string',
      description: 'Variables for the flow from a file of KEY=VALUE lines (a .env file). --env wins over it for the same name',
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

      // A flow file that uses other files (runFlow, runScript, addMedia and
      // the like) is uploaded with them, as a bundle. Sent alone, the device
      // could not find them.
      const bundled = flow && !dir && existsSync(flow) ? flowFileBundle(flow) : null;
      let yaml = inline;
      if (flow && !dir && !bundled) {
        try {
          yaml = readFileSync(flow, 'utf8');
        } catch (error) {
          throw new CliError(`Could not read ${flow}: ${(error as Error).message}`);
        }
      }

      const repeated = collectFlagValues('--env', rawArgs);
      const envFile = args['env-file'] as string | undefined;
      const fromFile = envFile ? parseEnvFile(envFile) : undefined;
      const fromFlags = parseEnvFlags(repeated.length > 0 ? repeated : args.env);
      const env = fromFile || fromFlags ? { ...fromFile, ...fromFlags } : undefined;
      const ctx = await context(args);
      id = await resolveSessionId(ctx.apiUrl, ctx.auth, id);

      let body: Parameters<typeof DeviceGateway.run>[3];
      if (bundled) {
        ctx.progress(ui.running(`${flow} uses other files: uploading it with them, from ${colors.highlight(bundled.dir)}…`));
        const bundle = await uploadFlowBundle({
          apiUrl: ctx.apiUrl,
          auth: ctx.auth,
          dir: bundled.dir,
          entry: bundled.entry,
          log: ctx.progress,
        });
        ctx.progress(ui.success(`Uploaded ${bundle.files} files`));
        body = { flowUploadId: bundle.id, flow: bundlePath(bundled.entry), ...(env && { env }) };
      } else if (dir) {
        ctx.progress(ui.running(`Uploading the flows in ${colors.highlight(dir)}…`));
        const bundle = await uploadFlowBundle({
          apiUrl: ctx.apiUrl,
          auth: ctx.auth,
          dir,
          entry,
          log: ctx.progress,
        });
        ctx.progress(ui.success(`Uploaded ${bundle.files} files`));
        body = {
          flowUploadId: bundle.id,
          ...(entry && { flow: bundlePath(path.normalize(entry)) }),
          ...(env && { env }),
        };
      } else {
        body = { yaml: yaml!, ...(env && { env }) };
      }

      ctx.progress(ui.running(`Running ${entry ?? flow ?? 'the flow'} on ${colors.highlight(id)}…`));
      let response = await DeviceGateway.run(ctx.apiUrl, ctx.auth, id, body, Boolean(args.force));
      if (response.status === 'running') {
        try {
          response = await waitForCommand(ctx, id, response);
        } catch (error) {
          throw withCommandId(error, id, response.command_id);
        }
      }

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
          printWarnings(response.session);
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

/** What the API's answer cap is, for the note that says it cut the answer. */
const LOGS_CAP = '24 KB';

const logsSub = defineCommand({
  meta: { name: 'logs', description: "The installed app's recent device log lines" },
  args: {
    ...commonArgs,
    id: idArg,
    lines: { type: 'string', default: '200', description: 'How many lines, up to 2000' },
    level: {
      type: 'string',
      description: `Only lines at this level and above: ${LOG_LEVELS.join(' or ')}`,
    },
    grep: {
      type: 'string',
      description: 'Only lines that contain this text, ignoring case',
    },
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
      const level = validateEnum(args.level as string | undefined, LOG_LEVELS, 'level');
      const grep = (args.grep as string | undefined)?.trim() || undefined;
      const filter = { ...(level && { level }), ...(grep && { grep }) };
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      const first = await DeviceGateway.logs(ctx.apiUrl, ctx.auth, id, lines, filter);
      const cutNote = `Only the newest lines that fit in ${LOGS_CAP} are shown. Ask for fewer with --lines, or narrow them with --level or --grep.`;
      if (!args.follow) {
        return {
          session: first.session,
          data: { logs: first.logs },
          print() {
            if (first.logs.lines.length === 0) {
              const none = level || grep ? 'No log lines match.' : 'No log lines yet.';
              logger.log(ui.info(first.logs.source === 'none' ? 'No app installed yet, so no app logs.' : none));
              printWarnings(first.session);
              return;
            }

            for (const line of first.logs.lines) logger.log(printable(line));
            if (first.logs.truncated) logger.log(ui.note(cutNote));
            printWarnings(first.session);
          },
        };
      }

      // --follow: print as lines arrive. Ends when the session does.
      for (const line of first.logs.lines) logger.log(printable(line));
      let shown = first.logs.lines;
      let { session } = first;
      for (;;) {
        await sleep(LOGS_FOLLOW_MS);
        try {
          const next = await pollOnce(ctx, (auth) => DeviceGateway.logs(ctx.apiUrl, auth, id, lines, filter));
          const fresh = newLogLines(shown, next.logs.lines);
          // Nothing in common with the last answer: more lines came in
          // between than one answer holds, and some were never shown.
          if (shown.length > 0 && fresh.length > 0 && fresh.length === next.logs.lines.length) {
            logger.log(colors.dim(`… some lines were missed: more arrived in ${LOGS_FOLLOW_MS / 1000}s than one read returns (--lines ${lines}, at most ${LOGS_CAP}).`));
          }

          for (const line of fresh) logger.log(printable(line));
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
      const opened = interactive(json) && (await openBrowser(session.monitor_url));
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

const HUMAN_POLL_MS = 5000;

/** The session is with a person: they were asked for help, or took control. */
function withPerson(human: DeviceHumanStatus): boolean {
  return human.waiting || human.human_in_control;
}

type HumanResponse = { human: DeviceHumanStatus; session: DeviceSession };

/**
 * Poll GET .../human until the person hands the session back (or gives up
 * control). A session that ends meanwhile is exit 4. Ctrl-C stops waiting
 * and leaves the session as it is.
 */
async function waitForHandBack(ctx: Ctx, id: string, first: HumanResponse): Promise<HumanResponse> {
  let current = first;
  if (!withPerson(current.human)) return current;
  ctx.progress(ui.running(`Waiting for a person to hand ${id} back. Ctrl-C stops waiting; the session stays open.`));
  for (;;) {
    if (ENDED_STATES.includes(current.session.state)) {
      throw new DeviceApiError(
        `Device session ${id} ended while waiting for a person (${current.session.release_reason ?? current.session.state}).`,
        410,
        'LIVE_SESSION_ENDED',
        current.session,
      );
    }

    if (!withPerson(current.human)) return current;
    await sleep(HUMAN_POLL_MS);
    current = await pollOnce(ctx, (auth) => DeviceGateway.human(ctx.apiUrl, auth, id));
  }
}

/** A person's part in a session, for `human` and `request-human`. */
function printHuman(id: string, human: DeviceHumanStatus, waited: boolean): void {
  if (waited && human.handed_back) logger.log(ui.success(`${id} was handed back`));
  logger.log(ui.section('Human help'));
  logger.log(ui.branch(ui.fields(humanFields(human))));
  if (!waited && withPerson(human)) {
    logger.log(ui.note(`Wait for the hand-back with \`dcd device human ${id} --wait\`.`));
  }
}

const waitForPersonArg = {
  type: 'boolean',
  default: false,
  description: `Wait until the person hands the session back (checks every ${HUMAN_POLL_MS / 1000}s; Ctrl-C stops waiting)`,
} as const;

/** Whether text has a session id's shape (it is never a sentence). */
function isSessionIdShaped(text: string): boolean {
  try {
    return checkSessionId(text) !== undefined;
  } catch {
    return false;
  }
}

const requestHumanSub = defineCommand({
  meta: {
    name: 'request-human',
    description: 'Ask a person for help (a 2FA code, a CAPTCHA): the session waits for them to hand it back',
  },
  args: {
    ...commonArgs,
    force: forceArg,
    message: {
      type: 'positional',
      // Checked in run, so a missing reason still fails with the --json envelope.
      required: false,
      description:
        'What the person should do, e.g. "Enter the 2FA code sent to the test phone". With --reason, this is the session id',
    },
    id: idArg,
    reason: {
      type: 'string',
      description: 'What the person should do; then the session id may come first, as in every other command',
    },
    wait: waitForPersonArg,
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      // `<reason> [id]`, or `[id] --reason <reason>`.
      const byFlag = typeof args.reason === 'string' ? args.reason : undefined;
      let given = args.message as string | undefined;
      let sessionId = args.id as string | undefined;
      if (byFlag !== undefined) {
        if (given !== undefined && sessionId !== undefined) {
          throw new CliError('With --reason, give at most one argument: the session id.');
        }

        sessionId ??= given;
        given = byFlag;
      }

      const reason = String(given ?? '').trim();
      if (!reason) throw new CliError('Say what the person should do, e.g. dcd device request-human "Enter the 2FA code".');
      if (reason.length > 500) throw new CliError('The reason is too long: keep it to 500 characters.');
      const ctx = await context(args);
      // `request-human brave-teal-otter` meant the session, not a reason:
      // sent, it would ask a person to "brave-teal-otter" and hold the
      // session for them.
      if (byFlag === undefined && sessionId === undefined && isSessionIdShaped(reason)) {
        const { sessions } = await DeviceGateway.list(ctx.apiUrl, ctx.auth);
        if (sessions.some((s) => s.id === reason)) {
          throw new CliError(
            `"${reason}" is a session id, not what the person should do. Say what they should do: dcd device request-human ${reason} --reason "Enter the 2FA code".`,
            DEVICE_EXIT.usage,
          );
        }
      }

      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, sessionId);
      let response = await DeviceGateway.requestHuman(ctx.apiUrl, ctx.auth, id, reason, Boolean(args.force));
      ctx.progress(ui.success(`Asked for a person on ${id}`));
      if (args.wait) response = await waitForHandBack(ctx, id, response);
      const { human, session } = response;
      return {
        session,
        data: { human },
        print() {
          printHuman(session.id, human, Boolean(args.wait));
        },
      };
    });
  },
});

const humanSub = defineCommand({
  meta: { name: 'human', description: 'Whether a session waits for a person, and their note when they hand it back' },
  args: { ...commonArgs, id: idArg, wait: waitForPersonArg },
  async run({ args }) {
    const json = Boolean(args.json);
    await runDeviceCommand(json, async () => {
      const ctx = await context(args);
      const id = await resolveSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
      let response = await DeviceGateway.human(ctx.apiUrl, ctx.auth, id);
      if (args.wait) response = await waitForHandBack(ctx, id, response);
      const { human, session } = response;
      return {
        session,
        data: { human },
        print() {
          printHuman(session.id, human, Boolean(args.wait));
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
    id: {
      ...idArg,
      description: 'Session id, e.g. brave-teal-otter. Optional: your most recent session, open or ended.',
    },
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
      // Most often run just after `stop`: your latest session, ended or not.
      const id = await resolveRecentSessionId(ctx.apiUrl, ctx.auth, args.id as string | undefined);
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

const subCommands = {
  start: strictFlags(startSub),
  list: strictFlags(listSub),
  status: strictFlags(statusSub),
  stop: strictFlags(stopSub),
  install: strictFlags(installSub),
  launch: strictFlags(launchSub),
  tap: strictFlags(tapSub),
  type: strictFlags(typeSub),
  swipe: strictFlags(swipeSub),
  'press-key': strictFlags(pressKeySub),
  'open-link': strictFlags(openLinkSub),
  'set-location': strictFlags(setLocationSub),
  models: strictFlags(modelsSub),
  inspect: strictFlags(inspectSub),
  screenshot: strictFlags(screenshotSub),
  run: strictFlags(runSub),
  logs: strictFlags(logsSub),
  open: strictFlags(openSub),
  artifacts: strictFlags(artifactsSub),
  'request-human': strictFlags(requestHumanSub),
  human: strictFlags(humanSub),
};

/** The MCP and API names of things `dcd device` calls by another name. */
const OTHER_NAMES: Record<string, string> = {
  get_device_status: 'status',
  get_human_status: 'human',
  get_logs: 'logs',
  input_text: 'type',
  inspect_screen: 'inspect',
  install_app: 'install',
  launch_app: 'launch',
  list_devices: 'list',
  start_device: 'start',
  stop_device: 'stop',
  take_screenshot: 'screenshot',
  tap_on: 'tap',
};

/**
 * The usage error for `dcd device <name>` when there is no such subcommand,
 * with the one meant: `press_key` is `press-key` here.
 */
export function unknownSubcommandError(name: string | undefined): CliError {
  const names = Object.keys(subCommands);
  if (name === undefined) {
    return new CliError(`Name a command: ${names.join(', ')}. See \`dcd device --help\`.`, DEVICE_EXIT.usage);
  }

  const dashed = name.replaceAll('_', '-').toLowerCase();
  const meant = OTHER_NAMES[name] ?? (names.includes(dashed) ? dashed : undefined);
  return new CliError(
    `Unknown command "${name}".${meant ? ` Did you mean \`dcd device ${meant}\`?` : ''} The commands are: ${names.join(', ')}.`,
    DEVICE_EXIT.usage,
  );
}

export const deviceCommand = defineCommand({
  meta: {
    name: 'device',
    description: 'Cloud devices you (or an AI agent) can lease, drive and release [beta]',
  },
  // Before citty looks the subcommand up: an unknown one under --json gets
  // the device envelope (exit 1), not the top-level `{ status, error }`.
  async setup({ rawArgs }) {
    const name = rawArgs.find((arg) => !arg.startsWith('-'));
    if (name !== undefined && name in subCommands) return;
    const json = rawArgs.includes('--json') || rawArgs.includes('--json=true');
    // A person who typed just `dcd device` gets citty's usage, with the list.
    if (name === undefined && !json) return;
    await runDeviceCommand(json, async () => {
      throw unknownSubcommandError(name);
    });
  },
  subCommands,
});

