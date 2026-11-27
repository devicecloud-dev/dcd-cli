/**
 * The DeviceCloud device provider for e2e (https://github.com/e2e-inc/e2e),
 * published as `@devicecloud.dev/dcd/e2e`. The public entry point is
 * `./index.ts`; this module takes its dependencies as arguments so the unit
 * tests can replace the network and the upload.
 *
 * Each e2e worker slot gets its own DeviceCloud device session. The provider
 * starts it, waits until its device is up and the build is installed, then
 * asks for the device's engine (`POST /device/sessions/:id/engine`). The
 * answer is the address of the session's own agent-device daemon, reached
 * through DeviceCloud's relay, and a token for it: that is what an e2e lease
 * is. e2e then drives the device directly, so its calls do not pass through
 * the API's command queue. `release` stops the session.
 *
 * When a test records video, `record` gives e2e a link for it instead of a
 * file: the session's page in the DeviceCloud console, at that test's part of
 * the session's own recording (`?from=&to=`, clock times). The recording is
 * one video for the whole session, finished when the session ends, so no
 * per-test file exists when the test does.
 *
 * The types below describe e2e's provider contract (`DeviceProvider` in
 * `@e2e-dev/mobile`) by shape, for the fields this provider uses, so the
 * package does not depend on e2e. An object of this type can be passed to
 * `mobile({ device })`.
 */
import { checkApiUrl } from '../utils/api-url.js';

/** What e2e asks for: one device for one worker slot of a run. */
export interface E2eDeviceRequest {
  readonly platform: 'android' | 'ios';
  /** The agent-device version the e2e client speaks. */
  readonly agentDeviceVersion: string;
  /** The target's `app.bundleId`, when the config names one. */
  readonly app?: string | undefined;
  /** The target's `app.appPath`, resolved to an absolute path, when the config names one. */
  readonly appPath?: string | undefined;
  /** The run's environment. A provider reads its credentials from here, never `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborts when the run is interrupted. */
  readonly signal: AbortSignal;
  /** One line of progress in the run's output. */
  readonly log: (line: string) => void;
}

/** One leased device, as `acquire` returns it and `release` gets it back. */
export interface E2eDeviceLease {
  /** The device session's id. */
  readonly id: string;
  readonly daemon?:
    { readonly authToken: string; readonly baseUrl: string } | undefined;
  readonly deviceId?: string | undefined;
  /** The bundle id or package of the build this provider installed from the request's `appPath`. */
  readonly installedApp?: string | undefined;
}

/** Handed to `release`, once per lease at the end of the run. */
export interface E2eReleaseContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

/** Handed to `record`, once per test attempt that records video. */
export interface E2eRecordContext {
  readonly attemptId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly targetName: string;
}

/** What a stopped recording became: here always a link, with its media type. */
export interface E2eRecordingResult {
  readonly mediaType: string;
  readonly url: string;
}

/** A test attempt's recording, as `record` starts it (`ProviderRecording` in `@e2e-dev/core/engine`). */
export interface E2eRecording {
  /** When it started, as an ISO time. */
  readonly startedAt: string;
  stop(context: {
    readonly dir: string;
    readonly signal: AbortSignal;
  }): Promise<E2eRecordingResult>;
}

/** A source of DeviceCloud devices for e2e, the shape of `@e2e-dev/mobile`'s `DeviceProvider`. */
export interface DeviceCloudProvider {
  readonly name: string;
  acquire(request: E2eDeviceRequest): Promise<E2eDeviceLease>;
  /** A test attempt's video: a console link to its part of the session's recording. */
  record(
    lease: E2eDeviceLease,
    context: E2eRecordContext,
  ): Promise<E2eRecording>;
  release(lease: E2eDeviceLease, context: E2eReleaseContext): Promise<void>;
}

export interface DeviceCloudOptions {
  /**
   * The DeviceCloud API key. Without it, `DEVICE_CLOUD_API_KEY` from the run's
   * environment. The key needs access to device sessions.
   */
  apiKey?: string;
  /** The DeviceCloud API. Without it, `DCD_API_URL` from the run's environment, then https://api.devicecloud.dev. */
  apiUrl?: string;
  /**
   * A build already uploaded (the id `dcd upload` prints). Without it, the
   * provider uploads the target's `app.appPath`, when the config names one,
   * once per run. Either way the session installs the build, and e2e
   * installs nothing itself.
   */
  appBinaryId?: string;
  /** Device model, as `GET /device/models` lists them. The platform's default without. */
  model?: string;
  /** OS version for that model. Its default without. */
  os?: string;
  /** How long each session may last, in minutes. The organization's limit without. */
  maxDurationMin?: number;
  /**
   * The device's locale, as `en_US` or `en-US`: set before the build is
   * installed or opened. The device's own default without.
   */
  locale?: string;
}

/** What the provider calls out to: the network, the upload, and the clock. */
export interface ProviderDeps {
  fetch: typeof fetch;
  /** Uploads a local build the way `dcd upload` does and answers its binary id. */
  upload: (args: {
    apiKey: string;
    apiUrl: string;
    filePath: string;
    log: (line: string) => void;
  }) => Promise<string>;
  /** Sent as `x-dcd-cli-version`, so the API knows which provider version called. */
  version: string;
  /** Between polls. */
  pollMs: number;
  /** How long a session may take to be ready: queued, starting, installing. */
  startTimeoutMs: number;
  /** The clock, in ms. `Date.now` without. */
  now?: () => number;
}

const DEFAULT_API_URL = 'https://api.devicecloud.dev';
const ENDED = new Set(['expired', 'failed', 'released']);
/** How many times to ask for the engine while the device is up but not quite ready for it (425). */
const ENGINE_ATTEMPTS = 10;
/**
 * How many times a request that is safe to repeat is sent again after the
 * network failed it (no answer at all). Polls run for minutes, and one lost
 * request must not end a run. Never a session start: sent twice, it could
 * start two sessions.
 */
const NETWORK_RETRIES = 4;

interface SessionBlock {
  id: string;
  install?: { error?: null | string; status?: string } | null;
  monitor_url?: string;
  release_reason?: null | string;
  state: string;
}

interface EngineBlock {
  agentDeviceVersion?: string;
  daemon: { authToken: string; baseUrl: string };
  deviceId: string;
}

interface Reply {
  json: Record<string, unknown> | null;
  status: number;
  text: string;
}

const wait = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Interrupted'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Interrupted'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** The API's own words for a failed request: its message, or the start of the body. */
function failure(what: string, reply: Reply): Error {
  const message = reply.json?.message;
  const said = Array.isArray(message)
    ? message.join('; ')
    : String(message ?? reply.text).slice(0, 300);
  const code =
    typeof reply.json?.error === 'string' && reply.json.error !== said
      ? ` (${reply.json.error})`
      : '';
  return new Error(
    `DeviceCloud: ${what} answered ${reply.status}: ${said}${code}`,
  );
}

/** Where to send requests, and with which key: checked before the key goes anywhere. */
function connection(
  options: DeviceCloudOptions,
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): { apiKey: string; apiUrl: string } {
  const apiKey = (options.apiKey ?? env.DEVICE_CLOUD_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error(
      'DeviceCloud: no API key. Set DEVICE_CLOUD_API_KEY in the environment e2e runs with, or pass apiKey to deviceCloud().',
    );
  }

  const raw =
    (options.apiUrl ?? env.DCD_API_URL ?? '').trim() || DEFAULT_API_URL;
  const check = checkApiUrl(raw);
  if (!check.ok) throw new Error(`DeviceCloud: ${check.reason}`);
  if (check.warning) log(check.warning);
  return { apiKey, apiUrl: check.origin };
}

/** A locale as the API takes it, `en_US`, from that or `en-US`. */
const LOCALE = /^[a-z]{2,3}_[A-Z]{2}$/;

function deviceLocale(locale: string | undefined): string | undefined {
  if (locale === undefined) return undefined;
  const normalised = locale.trim().replace('-', '_');
  if (!LOCALE.test(normalised)) {
    throw new Error(
      `DeviceCloud: "${locale}" is not a locale. Use a language and region, such as en_US or en-US.`,
    );
  }

  return normalised;
}

export function createProvider(
  options: DeviceCloudOptions,
  deps: ProviderDeps,
): DeviceCloudProvider {
  // Checked when the config is read, before any session is started or billed.
  const locale = deviceLocale(options.locale);
  // One upload per build per run: e2e acquires every worker slot at once.
  const uploads = new Map<string, Promise<string>>();
  const now = deps.now ?? Date.now;
  // Each lease's page in the console, read once per worker process: e2e
  // records in the worker, which has the lease's id but not the session.
  const pages = new Map<string, Promise<string>>();

  const client =
    (apiKey: string, apiUrl: string) =>
    async (
      method: 'DELETE' | 'GET' | 'POST',
      path: string,
      body?: unknown,
      signal?: AbortSignal,
      { repeatable = method !== 'POST' }: { repeatable?: boolean } = {},
    ): Promise<Reply> => {
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await deps.fetch(`${apiUrl}${path}`, {
            headers: {
              'x-app-api-key': apiKey,
              'x-dcd-cli-version': deps.version,
              'x-dcd-source': 'cli',
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            },
            method,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            ...(signal ? { signal } : {}),
          });
          break;
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          if (!repeatable || attempt >= NETWORK_RETRIES) {
            const cause = (
              error as { cause?: { code?: string; message?: string } }
            ).cause;
            const why =
              cause?.code ?? cause?.message ?? (error as Error).message;
            throw new Error(
              `DeviceCloud: ${method} ${path} could not reach ${apiUrl} (${why})`,
              { cause: error },
            );
          }

          await wait(deps.pollMs * (attempt + 1), signal);
        }
      }

      const text = await response.text();
      let json: null | Record<string, unknown> = null;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Not JSON: the status and the text say what happened.
      }

      return { json, status: response.status, text };
    };

  const binaryFor = async (
    request: E2eDeviceRequest,
    apiKey: string,
    apiUrl: string,
  ): Promise<string | undefined> => {
    if (options.appBinaryId) {
      if (request.appPath)
        request.log(
          `installing build ${options.appBinaryId}, not uploading ${request.appPath}`,
        );
      return options.appBinaryId;
    }

    if (!request.appPath) return undefined;
    let upload = uploads.get(request.appPath);
    if (!upload) {
      request.log(`uploading ${request.appPath}`);
      upload = deps.upload({
        apiKey,
        apiUrl,
        filePath: request.appPath,
        log: request.log,
      });
      uploads.set(request.appPath, upload);
      // A failed upload is tried again by the next run, not remembered.
      upload.catch(() => uploads.delete(request.appPath!));
    }

    return upload;
  };

  return {
    async acquire(request) {
      // e2e cannot install a build on a DeviceCloud device; the session does.
      // e2e is told so (installedApp), which needs the build's bundle id.
      if (request.appPath && !request.app) {
        throw new Error(
          "DeviceCloud: the target names app.appPath but not app.bundleId. Set app.bundleId to the build's bundle id or package name.",
        );
      }

      const { apiKey, apiUrl } = connection(options, request.env, request.log);
      const api = client(apiKey, apiUrl);
      const binaryUploadId = await binaryFor(request, apiKey, apiUrl);

      const started = await api(
        'POST',
        '/device/sessions',
        {
          clientLabel: 'e2e',
          platform: request.platform,
          ...(binaryUploadId ? { binaryUploadId } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.os ? { os: options.os } : {}),
          ...(options.maxDurationMin
            ? { maxDurationMin: options.maxDurationMin }
            : {}),
          ...(locale ? { deviceLocale: locale } : {}),
        },
        request.signal,
      );
      if (started.status >= 300 || !started.json?.session)
        throw failure('starting a device session', started);
      let session = started.json.session as SessionBlock;
      const path = `/device/sessions/${encodeURIComponent(session.id)}`;
      // A session left running is billed until it idles out.
      const stop = () => api('DELETE', path).catch(() => {});

      try {
        if (session.monitor_url) request.log(`watch at ${session.monitor_url}`);
        // Queued, then starting, then installing: minutes when the fleet is busy.
        const deadline = Date.now() + deps.startTimeoutMs;
        for (;;) {
          if (ENDED.has(session.state)) {
            throw new Error(
              `DeviceCloud: session ${session.id} ended before it was ready (${session.release_reason ?? session.state})`,
            );
          }

          if (session.install?.status === 'failed') {
            throw new Error(
              `DeviceCloud: the build could not be installed on session ${session.id}: ${session.install.error ?? 'no reason given'}`,
            );
          }

          if (
            (session.state === 'ready' || session.state === 'active') &&
            session.install?.status !== 'installing'
          )
            break;
          if (Date.now() > deadline) {
            throw new Error(
              `DeviceCloud: session ${session.id} was not ready within ${Math.round(deps.startTimeoutMs / 60_000)} minutes`,
            );
          }

          await wait(deps.pollMs, request.signal);
          const read = await api('GET', path, undefined, request.signal);
          if (read.status >= 300 || !read.json?.session)
            throw failure('reading the device session', read);
          session = read.json.session as SessionBlock;
        }

        // The device is up; its engine may need a moment more (425).
        let engine: EngineBlock | null = null;
        for (let attempt = 0; attempt < ENGINE_ATTEMPTS && !engine; attempt++) {
          // Asking again is safe: the session has one engine, and every answer names it.
          const asked = await api(
            'POST',
            `${path}/engine`,
            {},
            request.signal,
            { repeatable: true },
          );
          if (asked.status === 425) {
            await wait(deps.pollMs, request.signal);
            continue;
          }

          if (asked.status >= 300 || !asked.json?.engine)
            throw failure("asking for the device's engine", asked);
          engine = asked.json.engine as EngineBlock;
        }

        if (!engine)
          throw new Error(
            `DeviceCloud: session ${session.id} never became ready for e2e`,
          );
        if (
          engine.agentDeviceVersion &&
          engine.agentDeviceVersion !== request.agentDeviceVersion
        ) {
          // Same wire protocol; said so that a difference can be read off a report.
          request.log(
            `the device runs agent-device ${engine.agentDeviceVersion}, this e2e ${request.agentDeviceVersion}`,
          );
        }

        return {
          daemon: engine.daemon,
          deviceId: engine.deviceId,
          id: session.id,
          // Only when the target names a build (appPath): the session installed one, so e2e installs nothing.
          ...(request.appPath ? { installedApp: request.app } : {}),
        };
      } catch (error) {
        await stop();
        throw error;
      }
    },

    name: 'devicecloud',

    async record(lease, context) {
      // The test starts once this returns: from now on is its part.
      const startedAt = new Date(now()).toISOString();
      let page = pages.get(lease.id);
      if (!page) {
        page = (async () => {
          const { apiKey, apiUrl } = connection(options, context.env, () => {});
          const read = await client(apiKey, apiUrl)(
            'GET',
            `/device/sessions/${encodeURIComponent(lease.id)}`,
            undefined,
            context.signal,
          );
          if (read.status >= 300 || !read.json?.session)
            throw failure(`reading device session ${lease.id}`, read);
          const { monitor_url: monitorUrl } = read.json.session as SessionBlock;
          if (!monitorUrl)
            throw new Error(
              `DeviceCloud: session ${lease.id} has no console page to link a test's video to`,
            );
          return monitorUrl;
        })();
        pages.set(lease.id, page);
        // A failed read is tried again by the next attempt, not remembered.
        page.catch(() => pages.delete(lease.id));
      }

      const monitorUrl = await page;
      return {
        startedAt,
        // No request here: stopping can't fail once the test is over.
        async stop() {
          const url = new URL(monitorUrl);
          url.searchParams.set('from', startedAt);
          url.searchParams.set('to', new Date(now()).toISOString());
          return { mediaType: 'text/html', url: url.href };
        },
      };
    },

    async release(lease, context) {
      const { apiKey, apiUrl } = connection(options, context.env, context.log);
      const stopped = await client(apiKey, apiUrl)(
        'DELETE',
        `/device/sessions/${encodeURIComponent(lease.id)}`,
        undefined,
        context.signal,
      );
      // 404 and 409: already gone, which is what was asked for.
      if (
        stopped.status >= 300 &&
        stopped.status !== 404 &&
        stopped.status !== 409
      ) {
        throw failure(`stopping device session ${lease.id}`, stopped);
      }
    },
  };
}
