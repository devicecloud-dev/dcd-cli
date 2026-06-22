/**
 * Supabase session operations for the CLI: refresh an expired access token
 * and sign-out (best-effort revocation on the Supabase side).
 *
 * Does not talk to the dcd API — the dcd-side session exchange lives in the
 * login command's loopback flow, where the frontend POSTs ciphertext back.
 */
import { createClient } from '@supabase/supabase-js';

import type { StoredSession } from '../utils/config-store.js';

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
      throw new Error(
        `Failed to refresh session: ${error?.message ?? 'no session returned'}. ` +
          `Run \`dcd login\` again.`,
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
