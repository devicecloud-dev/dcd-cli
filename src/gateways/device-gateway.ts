import type { AuthContext } from '../types/domain/auth.types.js';
import type {
  DeviceCatalogue,
  DeviceCommandResult,
  DeviceInstalledApp,
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
  session: DeviceSession | null;
  status: number;

  constructor(
    message: string,
    status: number,
    code: null | string,
    session: DeviceSession | null,
  ) {
    super(message);
    this.name = 'DeviceApiError';
    this.status = status;
    this.code = code;
    this.session = session;
  }
}

/**
 * The API's error envelope: `{ statusCode, message, error? }`, where `error`
 * is either Nest's status text or a machine code such as LIVE_NOT_FOUND.
 * Only an upper-case code is kept, so "Not Found" never reads as one.
 */
async function toDeviceApiError(res: Response): Promise<DeviceApiError> {
  const text = await res.text();
  let body: { error?: unknown; message?: unknown; session?: unknown } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: a proxy page or plain text. The text is the message.
  }

  const raw = Array.isArray(body.message) ? body.message.join('; ') : body.message;
  let message = typeof raw === 'string' && raw ? raw : text.trim() || `HTTP ${res.status}`;
  if (res.status === 401) {
    message =
      'Authentication failed — your credentials are invalid or expired. ' +
      `Re-run \`dcd login\` or check your API key. (${message})`;
  }

  const code =
    typeof body.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(body.error) ? body.error : null;
  const session =
    body.session && typeof body.session === 'object' ? (body.session as DeviceSession) : null;
  return new DeviceApiError(message, res.status, code, session);
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

  if (!res.ok) throw await toDeviceApiError(res);
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
export const DeviceGateway = {
  install(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    app: { binaryUploadId: string } | { url: string },
  ): Promise<{ app: DeviceInstalledApp; session: DeviceSession }> {
    return request(baseUrl, auth, 'POST', `${sessionPath(id)}/install`, app);
  },

  launch(
    baseUrl: string,
    auth: AuthContext,
    id: string,
    body: { appId?: string; clearState?: boolean },
  ): Promise<{ result: DeviceCommandResult; session: DeviceSession }> {
    return request(baseUrl, auth, 'POST', `${sessionPath(id)}/launch`, body);
  },

  list(
    baseUrl: string,
    auth: AuthContext,
    all = false,
  ): Promise<{ sessions: DeviceSession[] }> {
    return request(baseUrl, auth, 'GET', `/device/sessions${all ? '?all=true' : ''}`);
  },

  models(baseUrl: string, auth: AuthContext): Promise<DeviceCatalogue> {
    return request(baseUrl, auth, 'GET', '/device/models');
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

  stop(baseUrl: string, auth: AuthContext, id: string): Promise<{ session: DeviceSession }> {
    return request(baseUrl, auth, 'DELETE', sessionPath(id));
  },
};
