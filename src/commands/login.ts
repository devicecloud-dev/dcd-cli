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
 *  4. Frontend POSTs {state, code_challenge, access_token} to the dcd api at
 *     POST /cli-login/handoff — the access token is proof of identity only.
 *     The api verifies it, mints a *dedicated* Supabase session for the CLI
 *     (its own refresh-token family, so browser token rotation can't
 *     invalidate it), and stores it in a short-TTL row keyed by state.
 *  5. Meanwhile, the CLI polls POST /cli-login/claim with {state, code_verifier}.
 *     Once the api has the row, it verifies sha256(verifier) === challenge,
 *     deletes the row, and returns the session.
 *  6. CLI fetches /me/orgs with the fresh Bearer token and picks the org:
 *     `--org` if given, else the only one, else a picker that starts on the
 *     last login's org. Without a TTY nobody can answer the picker, so the
 *     last login's org is used, or the command fails pointing at `--org`.
 *     Org selection lives here, not in the web UI — that way the CLI login
 *     and `dcd switch-org` share one picker.
 *
 * Why PKCE + server rendezvous (instead of a localhost loopback): Safari
 * blocks HTTPS → HTTP fetches to 127.0.0.1 as mixed content, and a loopback
 * flow can't work at all over SSH / "open this URL on your phone". The
 * rendezvous endpoint makes both cases trivial. A leaked URL is inert: it
 * carries the challenge, not the verifier.
 */
import * as p from '@clack/prompts';
import { defineCommand } from 'citty';
import { createHash, randomBytes } from 'node:crypto';

import {
  type DcdEnvName,
  ENVIRONMENTS,
  inferEnvFromApiUrl,
  resolveFrontendUrl,
} from '../config/environments.js';
import { getSupabaseKey } from '../config/supabase-key.js';
import { jsonFlag } from '../config/flags/output.flags.js';
import { openBrowser } from '../utils/browser.js';
import { canPrompt } from '../utils/ci.js';
import { CliError, logger } from '../utils/cli.js';
import { readConfig, writeConfig } from '../utils/config-store.js';
import { fetchOrgs, selectOrg } from '../utils/orgs.js';
import { colors } from '../utils/styling.js';
import { ui } from '../utils/ui.js';

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
    org: {
      type: 'string',
      description: 'Organization to use, by name or id (skips the picker)',
    },
    json: jsonFlag,
  },
  async run({ args }) {
    const apiUrl = (args['api-url'] as string).replace(/\/$/, '');
    const frontendOverride = args['frontend-url'] as string | undefined;
    const noBrowser = args.browser === false;
    const json = Boolean(args.json);
    // citty gives '' for a bare `--org`. Refuse it, and an empty `--org "$ORG"`,
    // rather than fall back to an org the caller didn't ask for.
    const requestedOrg = (args.org as string | undefined)?.trim();
    if (requestedOrg === '') {
      throw new CliError('--org needs an organization name or id.');
    }
    // Login is interactive, so under --json the human rows and prompts move to
    // stderr (the user still needs the URL) and stdout gets only the result.
    const say = (m: string) => {
      if (json) process.stderr.write(`${m}\n`);
      else logger.log(m);
    };
    const promptOutput = json ? process.stderr : undefined;
    // Without a TTY (a script, CI, a shell an agent runs) nobody can answer a
    // prompt, so each one below falls back to the answer Enter would give.
    const interactive = canPrompt(promptOutput);

    // If there's an existing stored session, make the user confirm before we
    // overwrite it. Silent clobber is fine for power users but surprising if
    // someone runs `dcd login` by mistake while already authenticated. An
    // already-expired session gets no confirm: the user is here because a
    // command told them to re-login, and "Already logged in… keep session?"
    // would dead-end them on a session that no longer works.
    const existing = readConfig();
    if (existing?.session) {
      const now = Math.floor(Date.now() / 1000);
      if (existing.session.expires_at <= now) {
        say(
          ui.info(
            `Your session for ${existing.session.user_email} has expired — signing in again.`,
          ),
        );
      } else if (!interactive) {
        // The confirm below defaults to yes. The old session stays until the
        // new login succeeds, so this replaces nothing if it never completes.
        say(ui.info(`Already logged in as ${existing.session.user_email} — signing in again.`));
      } else {
        const currentOrg = existing.current_org_name ?? existing.current_org_id;
        const ok = await p.confirm({
          message:
            `Already logged in as ${existing.session.user_email}` +
            (currentOrg ? ` (org ${currentOrg})` : '') +
            `. Sign out and log in again?`,
          initialValue: true,
          output: promptOutput,
        });
        if (p.isCancel(ok) || !ok) {
          if (json) {
            logger.json({ status: 'UNCHANGED', user: existing.session.user_email });
          } else {
            logger.log(ui.info('Keeping existing session.'));
          }
          return;
        }
      }
    }

    const env = inferEnvFromApiUrl(apiUrl);
    const SUPABASE_URL = ENVIRONMENTS[env].supabase.url;
    const frontendUrl = (frontendOverride ?? resolveFrontendUrl(apiUrl)).replace(/\/$/, '');

    const state = randomBytes(32).toString('hex');
    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier, 'ascii').digest());

    const loginUrl = `${frontendUrl}/cli-login?state=${state}&code_challenge=${codeChallenge}`;

    say(ui.section('Signing in to devicecloud.dev'));

    const rows: string[] = [];
    if (noBrowser) {
      rows.push(ui.note('Open this URL in a browser to finish login:'), colors.highlight(loginUrl));
    } else {
      const opened = openBrowser(loginUrl);
      rows.push(
        ui.note(
          opened
            ? 'Opening your browser…'
            : 'Could not launch a browser. Open this URL manually:',
        ),
      );
      if (!opened) {
        rows.push(colors.highlight(loginUrl));
      }
    }
    rows.push(ui.note('Waiting for login to complete…'));
    say(ui.branch(rows));

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
        const supabaseUser = await probeSupabaseUser(iss, env, payload.access_token);
        const parts = [
          iss ? `token iss: ${iss}` : null,
          `supabase /auth/v1/user: ${supabaseUser}`,
        ].filter(Boolean);
        throw new CliError(`${(err as Error).message} [${parts.join(' | ')}]`);
      }
      const { org: chosen, fromLastLogin } = await selectOrg(orgs, {
        requested: requestedOrg,
        // Org ids are per environment (dev org 1 isn't prod org 1), so the
        // last login's org only counts if that login was to this same API.
        lastOrgId: existing?.api_url === apiUrl ? existing.current_org_id : undefined,
        interactive,
        output: promptOutput,
      });
      if (fromLastLogin) {
        say(
          ui.info(
            `No terminal to pick an organization in, so using ${chosen.name} from your last login.`,
          ),
        );
      }

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

      if (json) {
        logger.json({
          status: 'SUCCESS',
          user: payload.user_email,
          org: { id: chosen.id, name: chosen.name },
          env,
        });
        return;
      }

      logger.log(ui.success(`Logged in as ${colors.highlight(payload.user_email)}`));
      logger.log(
        ui.branch([
          ...ui.fields([['organization', colors.highlight(chosen.name)]]),
          ...(orgs.length > 1
            ? [ui.note(`Switch orgs later with ${colors.highlight('dcd switch-org')}`)]
            : []),
        ]),
      );
    } catch (error) {
      logger.error(error as Error, { exit: 1, json });
    }
  },
});

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
  env: DcdEnvName,
  token: string,
): Promise<string> {
  if (!iss) return 'skipped (no iss)';
  try {
    const res = await fetch(`${iss}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        apikey: await getSupabaseKey(env),
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
