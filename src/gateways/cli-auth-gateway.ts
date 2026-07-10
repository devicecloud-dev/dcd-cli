/**
 * Supabase session operations for the CLI: refresh an expired access token
 * and sign-out (best-effort revocation on the Supabase side).
 *
 * Does not talk to the dcd API — the dcd-side session exchange lives in the
 * login command's PKCE rendezvous flow (see src/commands/login.ts).
 */
import { createClient, isAuthApiError } from '@supabase/supabase-js';

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
  ) {
    super(message);
    this.name = 'SessionRefreshError';
  }
}

export interface RefreshedSession {
  access_token: string;
  refresh_token: string;
  /** Unix epoch seconds. */
  expires_at: number;
  user_email: string;
  user_id: string;
}

function client(supabaseUrl: string, supabaseAnonKey: string) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export const CliAuthGateway = {
  async refresh(
    supabaseUrl: string,
    supabaseAnonKey: string,
    session: StoredSession,
  ): Promise<RefreshedSession> {
    const sb = client(supabaseUrl, supabaseAnonKey);
    const { data, error } = await sb.auth.refreshSession({
      refresh_token: session.refresh_token,
    });
    if (error || !data.session || !data.user) {
      // 4xx from GoTrue means the token itself was rejected; anything else
      // (fetch failure, 5xx) could succeed on retry with the same token.
      const definitive =
        error != null &&
        isAuthApiError(error) &&
        error.status >= 400 &&
        error.status < 500;
      throw new SessionRefreshError(
        `Failed to refresh session: ${error?.message ?? 'no session returned'}. ` +
          `Run \`dcd login\` again.`,
        definitive,
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
    supabaseAnonKey: string,
    session: StoredSession,
  ): Promise<void> {
    // `scope: 'local'` clears this client's SDK state only — no server call,
    // no revocation. supabase-js defaults to `scope: 'global'`, which revokes
    // EVERY session for the user (browser, mobile, other CLIs), so
    // `dcd logout` would kick the user out of the web app. We don't want
    // that — logging out locally should be local.
    const sb = client(supabaseUrl, supabaseAnonKey);
    try {
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
