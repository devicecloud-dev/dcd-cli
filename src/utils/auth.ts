/**
 * Resolves which credential a command should use and returns the fetch headers
 * to send. Precedence: --api-key flag > DEVICE_CLOUD_API_KEY env > stored
 * Supabase session (refreshed if near expiry). Throws CliError if none found.
 *
 * The refresh path writes the rotated tokens back to disk atomically. Callers
 * use the returned AuthContext for the duration of the command — one resolve
 * per invocation, not per request.
 */
import { ENVIRONMENTS } from '../config/environments';
import { CliAuthGateway } from '../gateways/cli-auth-gateway';
import { telemetry } from '../services/telemetry.service';
import type { AuthContext } from '../types/domain/auth.types';

import { CliError } from './cli';
import { readConfig, writeConfig } from './config-store';

const REFRESH_SKEW_SECONDS = 60;

export interface ResolveAuthOptions {
  apiKeyFlag: string | undefined;
  /** When true, bypass stored session entirely (for `dcd login` itself). */
  skipSession?: boolean;
}

export async function resolveAuth(
  opts: ResolveAuthOptions,
): Promise<AuthContext> {
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

  if (opts.skipSession) {
    throw missingCredentialsError();
  }

  const config = readConfig();
  if (!config?.session) {
    throw missingCredentialsError();
  }

  const now = Math.floor(Date.now() / 1000);
  let session = config.session;

  if (session.expires_at <= now + REFRESH_SKEW_SECONDS) {
    const { anonKey } = ENVIRONMENTS[config.env].supabase;
    const refreshed = await CliAuthGateway.refresh(
      config.supabase_url,
      anonKey,
      session,
    );
    session = refreshed;
    writeConfig({ ...config, session: refreshed });
  }

  if (!config.current_org_id) {
    throw new CliError(
      'No active organization set. Run `dcd switch-org <slug>` to pick one.',
    );
  }

  const auth: AuthContext = {
    mode: 'bearer',
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

function missingCredentialsError(): CliError {
  return new CliError(
    'Not authenticated. Provide an API key via --api-key or the DEVICE_CLOUD_API_KEY environment variable, or run `dcd login`.',
  );
}
