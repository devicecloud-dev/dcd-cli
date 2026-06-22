/**
 * Resolves which credential a command should use and returns the fetch headers
 * to send. Precedence: --api-key flag > DEVICE_CLOUD_API_KEY env > stored
 * Supabase session (refreshed if near expiry). Throws CliError if none found.
 *
 * The refresh path writes the rotated tokens back to disk atomically. Callers
 * use the returned AuthContext for the duration of the command — one resolve
 * per invocation, not per request.
 */
import { closeSync, openSync, rmSync, statSync } from 'node:fs';

import { ENVIRONMENTS } from '../config/environments';
import { CliAuthGateway } from '../gateways/cli-auth-gateway';
import { telemetry } from '../services/telemetry.service';
import type { AuthContext } from '../types/domain/auth.types';

import { CliError } from './cli';
import {
  StoredConfig,
  StoredSession,
  getConfigPath,
  readConfig,
  writeConfig,
} from './config-store';

const REFRESH_SKEW_SECONDS = 60;
// Refresh lock tuning: a refresh is a single HTTP round-trip, so anything
// holding the lock longer than this is presumed dead.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 250;

export interface ResolveAuthOptions {
  apiKeyFlag: string | undefined;
  /** When true, bypass stored session entirely (for `dcd login` itself). */
  skipSession?: boolean;
  /**
   * When true, ignore the --api-key flag / DEVICE_CLOUD_API_KEY env and
   * resolve straight from the stored session (for `dcd switch-org`, which
   * needs a browser login even when an API key is exported).
   */
  sessionOnly?: boolean;
}

export async function resolveAuth(
  opts: ResolveAuthOptions,
): Promise<AuthContext> {
  if (!opts.sessionOnly) {
    const flag = opts.apiKeyFlag?.trim();
    if (flag) {
      const auth: AuthContext = {
        mode: 'apiKey',
        headers: { 'x-app-api-key': flag },
      };
      telemetry.configure({ auth });
      return auth;
    }

    const env = process.env.DEVICE_CLOUD_API_KEY?.trim();
    if (env) {
      const auth: AuthContext = {
        mode: 'apiKey',
        headers: { 'x-app-api-key': env },
      };
      telemetry.configure({ auth });
      return auth;
    }
  }

  if (opts.skipSession) {
    throw missingCredentialsError();
  }

  let config = readConfig();
  if (!config?.session) {
    throw missingCredentialsError();
  }

  const now = Math.floor(Date.now() / 1000);
  let session = config.session;

  if (session.expires_at <= now + REFRESH_SKEW_SECONDS) {
    ({ config, session } = await refreshSessionWithLock(config));
  }

  if (!config.current_org_id) {
    throw new CliError(
      'No active organization set. Run `dcd switch-org <slug>` to pick one.',
    );
  }

  const auth: AuthContext = {
    mode: 'bearer',
    accessToken: session.access_token,
    env: config.env,
    orgId: config.current_org_id,
    userEmail: session.user_email,
    headers: {
      authorization: `Bearer ${session.access_token}`,
      'x-dcd-org': config.current_org_id,
    },
  };
  telemetry.configure({ auth, apiUrl: config.api_url });
  return auth;
}

/**
 * Refresh the stored session under a config-adjacent lockfile so two
 * concurrent `dcd` invocations (CI matrices) can't both consume the same
 * Supabase refresh token — token rotation would revoke the session family.
 */
async function refreshSessionWithLock(
  initial: StoredConfig,
): Promise<{ config: StoredConfig; session: StoredSession }> {
  const lockPath = `${getConfigPath()}.lock`;
  await acquireRefreshLock(lockPath);
  try {
    // Re-read: another process may have refreshed while we waited.
    const current = readConfig() ?? initial;
    const session = current.session ?? initial.session!;
    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at > now + REFRESH_SKEW_SECONDS) {
      return { config: current, session };
    }

    const { anonKey } = ENVIRONMENTS[current.env].supabase;
    const refreshed = await CliAuthGateway.refresh(
      current.supabase_url,
      anonKey,
      session,
    );
    // Re-read again and merge only `session` so a concurrent `switch-org`
    // write (org fields) isn't reverted by our pre-refresh snapshot.
    const merged: StoredConfig = { ...(readConfig() ?? current), session: refreshed };
    writeConfig(merged);
    return { config: merged, session: refreshed };
  } finally {
    try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }
}

async function acquireRefreshLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return;
    } catch {
      if (Date.now() >= deadline) {
        // Don't hang the command forever: steal the lock if possible and
        // proceed regardless — worst case we race like the pre-lock code did.
        try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
        try { closeSync(openSync(lockPath, 'wx')); } catch { /* best effort */ }
        return;
      }

      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          // Holder presumed dead — take over.
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock vanished between open and stat — fall through to a short
        // sleep (not an immediate retry) so persistent fs errors can't spin.
      }

      await new Promise<void>((resolve) => { setTimeout(resolve, LOCK_POLL_MS); });
    }
  }
}

function missingCredentialsError(): CliError {
  return new CliError(
    'Not authenticated. Provide an API key via --api-key or the DEVICE_CLOUD_API_KEY environment variable, or run `dcd login`.',
  );
}
