/**
 * `dcd login` — delegates auth to the web frontend and persists the resulting
 * Supabase session locally.
 *
 * Flow (PKCE S256, no loopback):
 *  1. CLI mints:
 *       - `state`:        32 random bytes, hex
 *       - `code_verifier`:32 random bytes, base64url
 *       - `code_challenge` = base64url(sha256(code_verifier))
 *  2. CLI opens <frontend>/cli-login?state=...&code_challenge=... in the browser.
 *  3. User signs in (OTP or SSO) and explicitly authorizes the handoff on
 *     the frontend.
 *  4. Frontend POSTs {state, code_challenge, session...} to the dcd api at
 *     POST /cli-login/handoff. The api stores a short-TTL row keyed by state.
 *  5. Meanwhile, the CLI polls POST /cli-login/claim with {state, code_verifier}.
 *     Once the api has the row, it verifies sha256(verifier) === challenge,
 *     deletes the row, and returns the session.
 *  6. CLI fetches /me/orgs with the fresh Bearer token and prompts the user to
 *     pick an org. Org selection lives here, not in the web UI — that way the
 *     CLI login and `dcd switch-org` share one picker.
 *
 * Why PKCE + server rendezvous (instead of a localhost loopback): Safari
 * blocks HTTPS → HTTP fetches to 127.0.0.1 as mixed content, and a loopback
 * flow can't work at all over SSH / "open this URL on your phone". The
 * rendezvous endpoint makes both cases trivial. A leaked URL is inert: it
 * carries the challenge, not the verifier.
 */
import * as p from '@clack/prompts';
import { defineCommand } from 'citty';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

import { ENVIRONMENTS, inferEnvFromApiUrl, resolveFrontendUrl } from '../config/environments.js';
import { CliError, logger } from '../utils/cli.js';
import { readConfig, writeConfig } from '../utils/config-store.js';
import { fetchOrgs, pickOrg } from '../utils/orgs.js';
import { colors, sectionHeader, symbols } from '../utils/styling.js';

interface ClaimedSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_email: string;
  user_id: string;
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// 1s feels snappy after the user clicks "Authorize" in the browser. The api
// rate-limits /cli-login/claim at 60/min which is exactly this cadence.
const POLL_INTERVAL_MS = 1000;

export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    description: 'Authenticate with devicecloud.dev via your browser',
  },
  args: {
    'api-url': {
      type: 'string',
      default: 'https://api.devicecloud.dev',
      description: 'API base URL',
    },
    'frontend-url': {
      type: 'string',
      description:
        'Override the frontend URL used to complete login (defaults per env)',
    },
    // citty treats `--no-<flag>` as negating `<flag>`, so the flag has to be
    // named `browser` (defaulting true) for `--no-browser` to set it false.
    browser: {
      type: 'boolean',
      default: true,
      description: 'Open the login URL in a browser (pass --no-browser to just print it)',
    },
  },
  async run({ args }) {
    const apiUrl = (args['api-url'] as string).replace(/\/$/, '');
    const frontendOverride = args['frontend-url'] as string | undefined;
    const noBrowser = args.browser === false;

    // If there's an existing stored session, make the user confirm before we
    // overwrite it. Silent clobber is fine for power users but surprising if
    // someone runs `dcd login` by mistake while already authenticated.
    const existing = readConfig();
    if (existing?.session) {
      const currentOrg = existing.current_org_name ?? existing.current_org_id;
      const ok = await p.confirm({
        message:
          `Already logged in as ${existing.session.user_email}` +
          (currentOrg ? ` (org ${currentOrg})` : '') +
          `. Sign out and log in again?`,
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        logger.log(`${symbols.info} Keeping existing session.`);
        return;
      }
    }

    const env = inferEnvFromApiUrl(apiUrl);
    const SUPABASE_URL = ENVIRONMENTS[env].supabase.url;
    const frontendUrl = (frontendOverride ?? resolveFrontendUrl(apiUrl)).replace(/\/$/, '');

    const state = randomBytes(32).toString('hex');
    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier, 'ascii').digest());

    const loginUrl = `${frontendUrl}/cli-login?state=${state}&code_challenge=${codeChallenge}`;

    logger.log(sectionHeader('Signing in to devicecloud.dev'));

    if (noBrowser) {
      logger.log(`   ${colors.dim('Open this URL in a browser to finish login:')}`);
      logger.log(`   ${colors.highlight(loginUrl)}`);
    } else {
      logger.log(`   ${colors.dim('Opening your browser...')}`);
      const opened = openBrowser(loginUrl);
      if (!opened) {
        logger.log(
          `   ${colors.dim('Could not launch a browser. Open this URL manually:')}`,
        );
        logger.log(`   ${colors.highlight(loginUrl)}`);
      }
    }

    logger.log(`   ${colors.dim('Waiting for login to complete...')}\n`);

    try {
      const payload = await pollForClaim(apiUrl, state, codeVerifier);
      if (!payload.access_token || typeof payload.access_token !== 'string') {
        throw new CliError('Claim response did not include an access_token.');
      }
      // Fetch orgs with the just-minted Bearer token. We don't write the
      // config until the user has picked an org — half-completed state isn't
      // useful and the handoff row is already single-use consumed.
      const bearerHeaders = {
        authorization: `Bearer ${payload.access_token}`,
      };
      let orgs;
      try {
        orgs = await fetchOrgs(apiUrl, bearerHeaders);
      } catch (err) {
        // The api rejected the JWT. Before blaming the api, hit Supabase's
        // own /auth/v1/user directly with the same token — if Supabase also
        // rejects it, the token itself is bad; if Supabase accepts, the
        // api's JwtService is misconfigured.
        const iss = decodeJwtIssuer(payload.access_token);
        const supabaseUser = await probeSupabaseUser(
          iss,
          ENVIRONMENTS[env].supabase.anonKey,
          payload.access_token,
        );
        const parts = [
          iss ? `token iss: ${iss}` : null,
          `supabase /auth/v1/user: ${supabaseUser}`,
        ].filter(Boolean);
        throw new CliError(`${(err as Error).message} [${parts.join(' | ')}]`);
      }
      const chosen = await pickOrg(orgs);

      writeConfig({
        version: 1,
        env,
        api_url: apiUrl,
        supabase_url: SUPABASE_URL,
        session: {
          access_token: payload.access_token,
          refresh_token: payload.refresh_token,
          expires_at: payload.expires_at,
          user_email: payload.user_email,
          user_id: payload.user_id,
        },
        current_org_id: chosen.id,
        current_org_name: chosen.name,
      });

      logger.log(
        `${symbols.success} ${colors.bold('Logged in')} as ${colors.highlight(payload.user_email)}`,
      );
      logger.log(`   ${colors.dim('Organization:')} ${colors.highlight(chosen.name)}`);
      if (orgs.length > 1) {
        logger.log(
          `   ${colors.dim('Switch orgs later with')} ${colors.highlight('dcd switch-org')}`,
        );
      }
    } catch (error) {
      logger.error(error as Error, { exit: 1 });
    }
  },
});

function openBrowser(url: string): boolean {
  const cmd =
    process.platform === 'darwin'
      ? { bin: 'open', args: [url] }
      : process.platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '""', url] }
        : { bin: 'xdg-open', args: [url] };
  try {
    const child = spawn(cmd.bin, cmd.args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function pollForClaim(
  apiUrl: string,
  state: string,
  codeVerifier: string,
): Promise<ClaimedSession> {
  const claimUrl = `${apiUrl}/cli-login/claim`;
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(claimUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, code_verifier: codeVerifier }),
      });
    } catch {
      // Network blip — don't kill the login, just back off and try again.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (res.ok) {
      return (await res.json()) as ClaimedSession;
    }
    if (res.status === 404) {
      // Not yet handed off (or already claimed elsewhere, or expired).
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (res.status === 429) {
      // Polled too fast — back off more aggressively before retrying.
      await sleep(POLL_INTERVAL_MS * 3);
      continue;
    }

    const body = await res.text().catch(() => '');
    throw new CliError(
      `Login failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
    );
  }

  throw new CliError('Login timed out. Please run `dcd login` again.');
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function probeSupabaseUser(
  iss: string | null,
  anonKey: string,
  token: string,
): Promise<string> {
  if (!iss) return 'skipped (no iss)';
  try {
    const res = await fetch(`${iss}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        apikey: anonKey,
      },
    });
    const bodyText = await res.text().catch(() => '');
    return `HTTP ${res.status}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ''}`;
  } catch (err) {
    return `network error: ${(err as Error).message}`;
  }
}

function decodeJwtIssuer(token: string): string | null {
  try {
    const [, payloadB64] = token.split('.');
    if (!payloadB64) return null;
    const json = Buffer.from(
      payloadB64.replaceAll('-', '+').replaceAll('_', '/'),
      'base64',
    ).toString('utf8');
    const parsed = JSON.parse(json) as { iss?: string };
    return parsed.iss ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default loginCommand;
