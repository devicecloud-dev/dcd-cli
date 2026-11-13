/**
 * Refreshes a `dcd login` session through the dcd API's
 * `POST /cli-login/refresh`, which calls Supabase Auth on the CLI's behalf.
 * The CLI holds no Supabase key for this.
 *
 * The login itself is the PKCE rendezvous in src/commands/login.ts.
 */
import type { StoredSession } from '../utils/config-store.js';

/**
 * Thrown when a session refresh fails. `definitive` distinguishes "this
 * refresh token was rejected" (revoked, already used, expired — re-login is
 * the only fix) from transient failures (network, 5xx, rate limit) where the
 * stored session may still be good on the next attempt.
 */
export class SessionRefreshError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean,
    /** Supabase Auth's error code (`session_expired`, …), when it sent one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SessionRefreshError';
  }
}

/**
 * What to tell the user for the refusals that have a plain cause. Supabase
 * Auth answers `session_expired` once a session passes the project's maximum
 * length or inactivity timeout, and `session_not_found` /
 * `refresh_token_not_found` once the session has been ended (signed out
 * elsewhere, revoked, or removed after expiring). Any other refusal keeps
 * Supabase's own message.
 */
const SIGNED_OUT = 'Your session was signed out. Run `dcd login` to sign in again.';
const REFRESH_REFUSAL_MESSAGES = new Map<string, string>([
  ['session_expired', 'Your session expired. Run `dcd login` to sign in again.'],
  ['session_not_found', SIGNED_OUT],
  ['refresh_token_not_found', SIGNED_OUT],
]);

export interface RefreshedSession {
  access_token: string;
  refresh_token: string;
  /** Unix epoch seconds. */
  expires_at: number;
  user_email: string;
  user_id: string;
}

/** The API's error envelope: `{ statusCode, error, message }`. */
interface ApiErrorBody {
  error?: unknown;
  message?: unknown;
}

export const CliAuthGateway = {
  /**
   * @param apiUrl The API the session was minted by (the stored `api_url`)
   * @param session The stored session, whose refresh token is spent on success
   * @param headers Extra headers, such as the CLI's identity headers
   */
  async refresh(
    apiUrl: string,
    session: StoredSession,
    headers: Record<string, string> = {},
  ): Promise<RefreshedSession> {
    let res: Response;
    try {
      res = await fetch(`${apiUrl.replace(/\/$/, '')}/cli-login/refresh`, {
        body: JSON.stringify({ refresh_token: session.refresh_token }),
        headers: { ...headers, 'content-type': 'application/json' },
        method: 'POST',
      });
    } catch (error) {
      // Never definitive: the token was not even tried.
      throw new SessionRefreshError(
        `Failed to refresh session: ${(error as Error).message}`,
        false,
      );
    }

    if (res.ok) {
      const s = (await res.json()) as Partial<RefreshedSession>;
      if (!s.access_token || !s.refresh_token || !s.expires_at || !s.user_id) {
        throw new SessionRefreshError('Failed to refresh session: incomplete response', false);
      }
      return {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at,
        user_email: s.user_email || session.user_email,
        user_id: s.user_id,
      };
    }

    let body: ApiErrorBody = {};
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // Not JSON (a proxy page, say). The status alone decides.
    }
    const code = typeof body.error === 'string' ? body.error : undefined;
    const reason =
      typeof body.message === 'string' && body.message ? body.message : `HTTP ${res.status}`;

    // 401: Supabase Auth refused the token, and `error` is its code. 400: the
    // API refused the request itself (an empty token). Only `dcd login` fixes
    // either. Anything else (404 from an API without this route, 429, 5xx)
    // may work later with the same token, so it must survive.
    const definitive = res.status === 401 || res.status === 400;
    const known = definitive && code ? REFRESH_REFUSAL_MESSAGES.get(code) : undefined;
    throw new SessionRefreshError(
      known ??
        `Failed to refresh session: ${reason}.` + (definitive ? ' Run `dcd login` again.' : ''),
      definitive,
      definitive ? code : undefined,
    );
  },
};
