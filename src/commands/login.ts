/**
 * `dcd login` — delegates auth to the web frontend and persists the resulting
 * Supabase session locally.
 *
 * Flow:
 *  1. CLI binds a loopback HTTP server on 127.0.0.1:<random-port> and mints
 *     a single-use `state` token.
 *  2. CLI opens <frontend>/cli-login?state=...&port=... in the browser.
 *  3. User signs in (OTP or SSO) and picks an org on the existing frontend.
 *  4. Frontend redirects to http://127.0.0.1:<port>/callback?state=...&tokens=<b64url(json)>.
 *  5. Loopback validates state, writes config, serves a "close this tab" page, exits.
 *
 * Loopback trust model: we bind 127.0.0.1 (loopback only, not 0.0.0.0) and
 * refuse any callback whose `state` doesn't match. Tokens travel over loopback
 * never over the network.
 */
import { defineCommand } from 'citty';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ENVIRONMENTS, inferEnvFromApiUrl, resolveFrontendUrl } from '../config/environments';
import { CliError, logger } from '../utils/cli';
import { writeConfig } from '../utils/config-store';
import { colors, sectionHeader, symbols } from '../utils/styling';

interface CallbackPayload {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_email: string;
  user_id: string;
  org_id: string;
  org_name?: string;
}

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

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
    'no-browser': {
      type: 'boolean',
      default: false,
      description: 'Print the login URL instead of opening a browser',
    },
  },
  async run({ args }) {
    const apiUrl = args['api-url'] as string;
    const frontendOverride = args['frontend-url'] as string | undefined;
    const noBrowser = Boolean(args['no-browser']);

    const env = inferEnvFromApiUrl(apiUrl);
    const SUPABASE_URL = ENVIRONMENTS[env].supabase.url;
    const frontendUrl = frontendOverride ?? resolveFrontendUrl(apiUrl);

    const state = randomBytes(32).toString('hex');

    const { server, port, waitForCallback } = await startLoopback(state);
    const loginUrl = `${frontendUrl.replace(/\/$/, '')}/cli-login?state=${state}&port=${port}`;

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
      const payload = await waitForCallback();
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
        current_org_id: payload.org_id,
        current_org_name: payload.org_name,
      });

      logger.log(
        `${symbols.success} ${colors.bold('Logged in')} as ${colors.highlight(payload.user_email)}`,
      );
      if (payload.org_name) {
        logger.log(`   ${colors.dim('Organization:')} ${colors.highlight(payload.org_name)}`);
      }
    } catch (error) {
      logger.error(error as Error, { exit: 1 });
    } finally {
      server.close();
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

interface LoopbackHandle {
  server: ReturnType<typeof createServer>;
  port: number;
  waitForCallback: () => Promise<CallbackPayload>;
}

async function startLoopback(expectedState: string): Promise<LoopbackHandle> {
  let resolvePayload: (payload: CallbackPayload) => void;
  let rejectPayload: (err: Error) => void;
  const settled = new Promise<CallbackPayload>((res, rej) => {
    resolvePayload = res;
    rejectPayload = rej;
  });

  const server = createServer((req, res) => handleRequest(req, res, expectedState, resolvePayload));
  server.on('error', (err) => rejectPayload(err));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  const timeout = setTimeout(() => {
    rejectPayload(new CliError('Login timed out. Please run `dcd login` again.'));
  }, CALLBACK_TIMEOUT_MS);
  timeout.unref();

  return {
    server,
    port,
    waitForCallback: () => settled,
  };
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedState: string,
  resolve: (p: CallbackPayload) => void,
): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const state = url.searchParams.get('state');
  const tokens = url.searchParams.get('tokens');
  if (!state || !tokens || state !== expectedState) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Invalid state');
    return;
  }
  let payload: CallbackPayload;
  try {
    const json = Buffer.from(tokens, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as CallbackPayload;
    if (
      !parsed.access_token ||
      !parsed.refresh_token ||
      !parsed.expires_at ||
      !parsed.user_email ||
      !parsed.user_id ||
      !parsed.org_id
    ) {
      throw new Error('Missing fields');
    }
    payload = parsed;
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Malformed payload');
    return;
  }
  res
    .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(successPage());
  resolve(payload);
}

function successPage(): string {
  return `<!doctype html>
<html><head><title>dcd login complete</title>
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center;
         height: 100vh; margin: 0; background: #0b0d10; color: #e6e9ef; }
  .card { padding: 2rem 2.5rem; border: 1px solid #1f2937; border-radius: 12px;
          background: #0f1419; text-align: center; max-width: 28rem; }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; }
  p { margin: 0; color: #94a3b8; }
</style></head>
<body><div class="card">
  <h1>Logged in to devicecloud.dev</h1>
  <p>You can close this tab and return to your terminal.</p>
</div></body></html>`;
}

export default loginCommand;
