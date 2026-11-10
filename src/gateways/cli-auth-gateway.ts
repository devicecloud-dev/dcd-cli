/**
 * Supabase session operations for the CLI: refresh an expired access token
 * and sign-out (best-effort revocation on the Supabase side).
 *
 * Does not talk to the dcd API — the dcd-side session exchange lives in the
 * login command's PKCE rendezvous flow (see src/commands/login.ts).
 */
import { createClient, isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';

import type { DcdEnvName } from '../config/environments.js';
import { getSupabaseKey } from '../config/supabase-key.js';
import type { StoredSession } from '../utils/config-store.js';

/**
 * Thrown when a session refresh fails. `definitive` distinguishes "Supabase
 * rejected this refresh token" (revoked, already used, malformed — re-login
 * is the only fix) from transient failures (network, GoTrue 5xx) where the
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

function client(supabaseUrl: string, supabaseKey: string) {
  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export const CliAuthGateway = {
  async refresh(
    supabaseUrl: string,
    env: DcdEnvName,
    session: StoredSession,
  ): Promise<RefreshedSession> {
    let supabaseKey: string;
    try {
      supabaseKey = await getSupabaseKey(env);
    } catch (error) {
      // Never definitive: the refresh token was not even tried, so the stored
      // session must survive for the next attempt.
      throw new SessionRefreshError(
        `Failed to refresh session: ${(error as Error).message}`,
        false,
      );
    }
    const sb = client(supabaseUrl, supabaseKey);
    const { data, error } = await sb.auth.refreshSession({
      refresh_token: session.refresh_token,
    });
    if (error || !data.session || !data.user) {
      // 4xx from GoTrue means the token itself was rejected; anything else
      // (fetch failure, 5xx) could succeed on retry with the same token.
      // supabase-js turns GoTrue's `session_not_found` into an
      // AuthSessionMissingError rather than an AuthApiError (it throws the same
      // for an empty refresh token); only `dcd login` fixes either.
      const apiError = error != null && isAuthApiError(error) ? error : undefined;
      const sessionMissing = error != null && isAuthSessionMissingError(error);
      const definitive =
        sessionMissing ||
        (apiError !== undefined && apiError.status >= 400 && apiError.status < 500);
      const code = apiError?.code ?? (sessionMissing ? 'session_not_found' : undefined);
      const known = definitive && code ? REFRESH_REFUSAL_MESSAGES.get(code) : undefined;
      throw new SessionRefreshError(
        known ??
          `Failed to refresh session: ${error?.message ?? 'no session returned'}. ` +
            `Run \`dcd login\` again.`,
        definitive,
        code,
      );
    }
    const s = data.session;
    const u = data.user;
    if (!s.expires_at) throw new Error('Refreshed session is missing expires_at');
    return {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at,
      user_email: u.email ?? session.user_email,
      user_id: u.id,
    };
  },

  async signOut(
    supabaseUrl: string,
    env: DcdEnvName,
    session: StoredSession,
  ): Promise<void> {
    // `scope: 'local'` clears this client's SDK state only — no server call,
    // no revocation. supabase-js defaults to `scope: 'global'`, which revokes
    // EVERY session for the user (browser, mobile, other CLIs), so
    // `dcd logout` would kick the user out of the web app. We don't want
    // that — logging out locally should be local.
    try {
      const sb = client(supabaseUrl, await getSupabaseKey(env));
      await sb.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      await sb.auth.signOut({ scope: 'local' });
    } catch {
      // Best effort — the local config will be wiped regardless.
    }
  },
};
