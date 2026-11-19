import type { AuthContext } from '../types/domain/auth.types.js';
import type {
  DeviceActionRequest,
  DeviceArtifactsPage,
  DeviceBundleUploadUrls,
  DeviceCatalogue,
  DeviceCommandResult,
  DeviceFlowBundle,
  DeviceFullScreenshot,
  DeviceHumanStatus,
  DeviceInstalledApp,
  DeviceLogLevel,
  DeviceLogs,
  DeviceRunResponse,
  DeviceScreen,
  DeviceScreenshot,
  DeviceSession,
  StartDeviceSessionRequest,
} from '../types/domain/device-session.types.js';
import { ApiGateway } from './api-gateway.js';

/**
 * An error answer from /device/sessions. Unlike ApiError it keeps the API's
 * machine code (`LIVE_NOT_FOUND`, `LIVE_SPEND_CAP`, …) and the `session`
 * block some errors carry, because `dcd device` maps the code to an exit code
 * and prints the session in its JSON envelope.
 */
export class DeviceApiError extends Error {
  code: null | string;
  /**
   * What else the answer said that a script can act on: how long to wait
   * (`retry_after_s`), the limit that was hit (`limit`, `spent`), how far
   * the device got (`phase`), or the command a wait was for (`command_id`).
   * Printed in the --json envelope's `error` beside `code` and `message`.
   */
  details: Record<string, unknown>;
  /**
   * The API itself answered (its `{ statusCode, message }` envelope), not a
   * proxy in front of it. A proxy's 502 can come after the API did the work.
   */
  fromApi: boolean;
  session: DeviceSession | null;
  status: number;

  constructor(
    message: string,
    status: number,
    code: null | string,
    session: DeviceSession | null,
    fromApi = false,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DeviceApiError';
    this.status = status;
    this.code = code;
    this.session = session;
    this.fromApi = fromApi;
    this.details = details;
  }
}

/** The fields of an error answer passed on to the caller, when the API sends them. */
const ERROR_DETAILS = ['retry_after_s', 'limit', 'spent', 'phase'] as const;

/** The longest error text kept from an answer that is not the API's JSON. */
const MAX_PLAIN_ERROR = 300;

/**
 * The message for an answer that is not the API's JSON: a proxy's page or
 * plain text. An HTML page is cut to its title, as a whole page in a
 * terminal, an envelope or a log says nothing a person can read.
 */
export function plainErrorText(text: string, status: number): string {
  const trimmed = text.trim();
  if (!trimmed) return `HTTP ${status}`;
  if (/^<(?:!doctype|html|head|body)\b/i.test(trimmed) || /<\/html>\s*$/i.test(trimmed)) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(trimmed)?.[1]?.replaceAll(/\s+/g, ' ').trim();
    return `HTTP ${status}: ${title || 'an error page'} (an HTML page, not the API's answer)`;
  }

  const oneLine = trimmed.replaceAll(/\s+/g, ' ');
  return oneLine.length > MAX_PLAIN_ERROR ? `${oneLine.slice(0, MAX_PLAIN_ERROR)}…` : oneLine;
}

/** How recent an open session must be to count as one a failed start may have made. */
export const START_RECOVERY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Whether a failed start may still have made a session: no answer arrived
 * (the connection failed, or the reply was unreadable), or a proxy answered
 * with a 5xx in the API's place. The API's own errors are refusals made
 * before any session exists.
 */
export function startOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof DeviceApiError)) return true;
  return error.status >= 500 && !error.fromApi;
}

/**
 * The API's error envelope: `{ statusCode, message, error? }`, where `error`
 * is either Nest's status text or a machine code such as LIVE_NOT_FOUND.
 * Only an upper-case code is kept, so "Not Found" never reads as one.
 */
async function toDeviceApiError(res: Response, path: string): Promise<DeviceApiError> {
  const text = await res.text();
  let body: Record<string, unknown> & {
    error?: unknown;
    message?: unknown;
    session?: unknown;
    statusCode?: unknown;
  } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: a proxy page or plain text. The text is the message.
  }

  const raw = Array.isArray(body.message) ? body.message.join('; ') : body.message;
  let message = typeof raw === 'string' && raw ? raw : plainErrorText(text, res.status);
  if (res.status === 401) {
    message =
      'Authentication failed — your credentials are invalid or expired. ' +
      `Re-run \`dcd login\` or check your API key. (${message})`;
  }

  const code =
    typeof body.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(body.error) ? body.error : null;
  if (code === 'LIVE_HUMAN_IN_CONTROL') {
    // The API's text points at MCP and raw HTTP too; a CLI user needs the command.
    const id = /^\/device\/sessions\/([^/?]+)/.exec(path)?.[1];
    const name = id ? decodeURIComponent(id) : '<id>';
    message =
      `A person has taken control of ${name} in the console, so it takes no commands until they hand it back. ` +
      `Wait for that with \`dcd device human ${name} --wait\`.`;
  }

  const session =
    body.session && typeof body.session === 'object' ? (body.session as DeviceSession) : null;
  // Nest's envelope always has a numeric statusCode. Railway's proxy answers
  // `{ status, code, message }`, or a page that isn't JSON at all.
  const fromApi = typeof body.statusCode === 'number';
  const details: Record<string, unknown> = {};
  if (fromApi) {
    for (const key of ERROR_DETAILS) {
      const value = body[key];
      if (typeof value === 'number' || typeof value === 'string') details[key] = value;
    }
  }

  return new DeviceApiError(message, res.status, code, session, fromApi, details);
}

async function request<T>(
  baseUrl: string,
  auth: AuthContext,
  method: 'DELETE' | 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...auth.headers,
        // Recorded as the command's source in the session timeline.
        'x-dcd-source': 'cli',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === 'fetch failed') {
      throw ApiGateway.enhanceFetchError(error, url);
    }

    throw error;
  }

  if (!res.ok) throw await toDeviceApiError(res, path);
  try {
    return (await res.json()) as T;
  } catch (error) {
    throw new Error(
      `${method} ${path}: the API returned an invalid JSON response (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
}

const sessionPath = (id: string) => `/device/sessions/${encodeURIComponent(id)}`;

/** The Agent Devices session API (dcd docs/device-v1-plan.md, section 4.1). */
/**
 * A changing request's body, with `force` when asked: the API refuses an
 * agent changing a session someone else started (LIVE_NOT_YOURS) unless it
 * says so. Left out otherwise, so an older API sees the body it always did.
 */
const withForce = <T extends object>(body: T, force: boolean): T | (T & { force: true }) =>
  force ? { ...body, force: true } : body;

export const DeviceGateway = {
  artifacts(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    before?: string,
  ): Promise<DeviceArtifactsPage> {
    const query = new URLSearchParams({ limit: '200', ...(before && { before }) });
    return request(baseUrl, auth, 'GET', `${sessionPath(id)}/artifacts?${query}`);
  },

  bundleUploadUrls(
    baseUrl: string,
    auth: AuthContext,
    bytes: number,
  ): Promise<DeviceBundleUploadUrls> {
    return request(baseUrl, auth, 'POST', '/device/bundles/upload-url', { bytes });
  },

  command(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    commandId: string,
  ): Promise<DeviceRunResponse> {
    return request(
      baseUrl,
      auth,
      'GET',
      `${sessionPath(id)}/commands/${encodeURIComponent(commandId)}`,
    );
  },

  /** Whether the session waits for a person, or was handed back. */
  human(
    baseUrl: string,
    auth: AuthContext,
    id: string,
  ): Promise<{ human: DeviceHumanStatus; session: DeviceSession }> {
    return request(baseUrl, auth, 'GET', `${sessionPath(id)}/human`);
  },

  inspect(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    all = false,
  ): Promise<{ screen: DeviceScreen; session: DeviceSession }> {
    return request(baseUrl, auth, 'GET', `${sessionPath(id)}/inspect${all ? '?all=true' : ''}`);
  },

  install(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    app: { binaryUploadId: string } | { url: string },
    force = false,
  ): Promise<{ app: DeviceInstalledApp; session: DeviceSession }> {
    return request(baseUrl, auth, 'POST', `${sessionPath(id)}/install`, withForce(app, force));
  },

  launch(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    body: { appId?: string; clearState?: boolean },
    force = false,
  ): Promise<{ result: DeviceCommandResult; session: DeviceSession }> {
    return request(baseUrl, auth, 'POST', `${sessionPath(id)}/launch`, withForce(body, force));
  },

  list(
    baseUrl: string,
    auth: AuthContext,
    all = false,
  ): Promise<{ sessions: DeviceSession[] }> {
    return request(baseUrl, auth, 'GET', `/device/sessions${all ? '?all=true' : ''}`);
  },

  /** The app's recent log lines; `level` and `grep` narrow them (the API ignores both before it knew them). */
  logs(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    lines: number,
    filter: { grep?: string; level?: DeviceLogLevel } = {},
  ): Promise<{ logs: DeviceLogs; session: DeviceSession }> {
    const query = new URLSearchParams({
      lines: String(lines),
      ...(filter.level && { level: filter.level }),
      ...(filter.grep && { grep: filter.grep }),
    });
    return request(baseUrl, auth, 'GET', `${sessionPath(id)}/logs?${query}`);
  },

  models(baseUrl: string, auth: AuthContext): Promise<DeviceCatalogue> {
    return request(baseUrl, auth, 'GET', '/device/models');
  },

  /**
   * The open sessions started in the last START_RECOVERY_WINDOW_MS: the ones
   * a start that got no answer may have made. Null when they can't be read.
   */
  async recentlyStarted(
    baseUrl: string,
    auth: AuthContext,
    now = Date.now(),
  ): Promise<DeviceSession[] | null> {
    try {
      const { sessions } = await DeviceGateway.list(baseUrl, auth);
      return sessions.filter((s) => now - Date.parse(s.created_at) <= START_RECOVERY_WINDOW_MS);
    } catch {
      return null;
    }
  },

  registerBundle(
    baseUrl: string,
    auth: AuthContext,
    body: {
      backblaze: boolean;
      bytes: number;
      enc?: unknown;
      id: string;
      sha: string;
      supabase: boolean;
    },
  ): Promise<{ bundle: DeviceFlowBundle }> {
    return request(baseUrl, auth, 'POST', '/device/bundles', body);
  },

  /** Ask a person for help: the session moves to needs_human until they hand it back. */
  requestHuman(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    reason: string,
    force = false,
  ): Promise<{ human: DeviceHumanStatus; session: DeviceSession }> {
    return request(baseUrl, auth, 'POST', `${sessionPath(id)}/request-human`, withForce({ reason }, force));
  },

  /** One typed action: tap, type, swipe, press_key, open_link or set_location. Synchronous: answers with the outcome. */
  action(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    body: DeviceActionRequest,
    force = false,
  ): Promise<{ result: DeviceCommandResult; session: DeviceSession }> {
    return request(baseUrl, auth, 'POST', `${sessionPath(id)}/actions`, withForce(body, force));
  },

  run(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    body:
      | { env?: Record<string, string>; flow?: string; flowUploadId: string }
      | { env?: Record<string, string>; yaml: string },
    force = false,
  ): Promise<DeviceRunResponse> {
    return request(baseUrl, auth, 'POST', `${sessionPath(id)}/run`, withForce(body, force));
  },

  screenshot(
    baseUrl: string,
    auth: AuthContext,
    id: string,
  ): Promise<{ screenshot: DeviceScreenshot; session: DeviceSession }> {
    return request(baseUrl, auth, 'GET', `${sessionPath(id)}/screenshot`);
  },

  /**
   * A PNG at the device's own resolution, as a link. A device whose runner
   * is too old for it answers LIVE_NOT_SUPPORTED.
   */
  fullScreenshot(
    baseUrl: string,
    auth: AuthContext,
    id: string,
  ): Promise<{ screenshot: DeviceFullScreenshot; session: DeviceSession }> {
    return request(baseUrl, auth, 'GET', `${sessionPath(id)}/screenshot?full=true`);
  },

  start(
    baseUrl: string,
    auth: AuthContext,
    body: StartDeviceSessionRequest,
  ): Promise<{ session: DeviceSession }> {
    return request(baseUrl, auth, 'POST', '/device/sessions', body);
  },

  status(baseUrl: string, auth: AuthContext, id: string): Promise<{ session: DeviceSession }> {
    return request(baseUrl, auth, 'GET', sessionPath(id));
  },

  stop(baseUrl: string, auth: AuthContext, id: string, force = false): Promise<{ session: DeviceSession }> {
    return request(baseUrl, auth, 'DELETE', `${sessionPath(id)}${force ? '?force=true' : ''}`);
  },
};
