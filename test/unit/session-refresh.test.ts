import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ApiGateway } from '../../src/gateways/api-gateway.js';
import {
  CliAuthGateway,
  SessionRefreshError,
} from '../../src/gateways/cli-auth-gateway.js';
import { RealtimeResultsGateway } from '../../src/gateways/realtime-gateway.js';
import { clearContextCache, getContext } from '../../src/mcp/context.js';
import { ReportDownloadService } from '../../src/services/report-download.service.js';
import {
  PollingAuthError,
  ResultsPollingService,
} from '../../src/services/results-polling.service.js';
import type { AuthContext } from '../../src/types/domain/auth.types.js';
import {
  isAuthExpiring,
  isDefinitiveAuthFailure,
  refreshAuth,
  resolveAuth,
} from '../../src/utils/auth.js';
import { CliError } from '../../src/utils/cli.js';
import { readConfig, writeConfig } from '../../src/utils/config-store.js';

/**
 * A `dcd login` session's access token lasts about an hour. Anything that can
 * run longer — the MCP server, a `dcd cloud` poll and the downloads after it —
 * must refresh it rather than keep sending the token it started with.
 */

const ORIGINAL_ENV = { ...process.env };
const realNow = Date.now;
const realRefresh = CliAuthGateway.refresh;
const realGetResults = ApiGateway.getResultsForUpload;
const realSubscribe = RealtimeResultsGateway.subscribe;
const realFetch = (global as any).fetch;

const nowSeconds = () => Math.floor(Date.now() / 1000);

let tempDir: string;

/** Write a stored `dcd login` config, as `dcd login` / a refresh would. */
function storeSession(
  accessToken: string,
  expiresInSeconds: number,
  orgId = '42',
): void {
  writeConfig({
    version: 1,
    env: 'prod',
    api_url: 'https://api.devicecloud.dev',
    supabase_url: 'https://cloud.devicecloud.dev',
    session: {
      access_token: accessToken,
      refresh_token: `refresh-for-${accessToken}`,
      expires_at: nowSeconds() + expiresInSeconds,
      user_email: 'u@example.com',
      user_id: 'u1',
    },
    current_org_id: orgId,
  });
}

/** A bearer context whose token expired a moment ago. */
function expiredBearer(accessToken = 'stale-token', orgId = '42'): AuthContext {
  return {
    mode: 'bearer',
    accessToken,
    env: 'prod',
    expiresAt: nowSeconds() - 5,
    orgId,
    userEmail: 'u@example.com',
    headers: { authorization: `Bearer ${accessToken}`, 'x-dcd-org': orgId },
  };
}

/** Fail loudly if a test that shouldn't reach Supabase does. */
function forbidNetworkRefresh(): void {
  CliAuthGateway.refresh = async () => {
    throw new Error('unexpected network refresh');
  };
}

describe('session refresh for long-running processes', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-refresh-test-'));
    process.env.DCD_CONFIG_DIR = tempDir;
    delete process.env.DEVICE_CLOUD_API_KEY;
    delete process.env.DCD_API_URL;
    forbidNetworkRefresh();
    clearContextCache();
  });

  afterEach(() => {
    Date.now = realNow;
    CliAuthGateway.refresh = realRefresh;
    ApiGateway.getResultsForUpload = realGetResults;
    RealtimeResultsGateway.subscribe = realSubscribe;
    (global as any).fetch = realFetch;
    clearContextCache();
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  describe('refreshAuth', () => {
    it('reports when a resolved session expires', async () => {
      storeSession('token-a', 3600);
      const auth = await resolveAuth({ apiKeyFlag: undefined });
      expect(auth.expiresAt).to.equal(readConfig()!.session!.expires_at);
      expect(isAuthExpiring(auth)).to.equal(false);
      expect(isAuthExpiring({ ...auth, expiresAt: nowSeconds() + 30 })).to.equal(true);
    });

    it('never touches API-key auth', async () => {
      const auth: AuthContext = { mode: 'apiKey', headers: { 'x-app-api-key': 'k' } };
      expect(isAuthExpiring(auth)).to.equal(false);
      expect(await refreshAuth(auth)).to.equal(auth);
    });

    it('returns a session that is not near expiry unchanged', async () => {
      storeSession('token-a', 3600);
      const auth = await resolveAuth({ apiKeyFlag: undefined });
      expect(await refreshAuth(auth)).to.equal(auth);
    });

    it('picks up a session another dcd process already refreshed, without a refresh call', async () => {
      storeSession('rotated-elsewhere', 3600);
      const next = await refreshAuth(expiredBearer());
      expect(next.headers.authorization).to.equal('Bearer rotated-elsewhere');
      expect(next.accessToken).to.equal('rotated-elsewhere');
      expect(isAuthExpiring(next)).to.equal(false);
    });

    it('keeps the org the command started with, even if another terminal switched org', async () => {
      storeSession('fresh', 3600, '99');
      const next = await refreshAuth(expiredBearer('stale', '42'));
      expect(next.orgId).to.equal('42');
      expect(next.headers['x-dcd-org']).to.equal('42');
      expect(next.headers.authorization).to.equal('Bearer fresh');
    });

    it('refreshes the stored session when it is expiring too, and saves the rotation', async () => {
      storeSession('stale', 10);
      CliAuthGateway.refresh = async () => ({
        access_token: 'refreshed',
        refresh_token: 'refresh-2',
        expires_at: nowSeconds() + 3600,
        user_email: 'u@example.com',
        user_id: 'u1',
      });

      const next = await refreshAuth(expiredBearer('stale'));
      expect(next.headers.authorization).to.equal('Bearer refreshed');
      expect(readConfig()!.session!.refresh_token).to.equal('refresh-2');
    });

    it('classifies a refused refresh token as final and drops the dead session', async () => {
      storeSession('stale', 10);
      CliAuthGateway.refresh = async () => {
        throw new SessionRefreshError('Invalid Refresh Token: Already Used', true);
      };

      let caught: unknown;
      try {
        await refreshAuth(expiredBearer('stale'));
      } catch (error) {
        caught = error;
      }

      expect(isDefinitiveAuthFailure(caught)).to.equal(true);
      expect(readConfig()!.session).to.equal(undefined);
      // With the session gone, the next attempt is "not authenticated": final too.
      let next: unknown;
      try {
        await refreshAuth(expiredBearer('stale'));
      } catch (error) {
        next = error;
      }

      expect(next).to.be.instanceOf(CliError);
      expect(isDefinitiveAuthFailure(next)).to.equal(true);
    });

    it('treats a network failure during refresh as retryable', () => {
      expect(isDefinitiveAuthFailure(new SessionRefreshError('fetch failed', false))).to.equal(
        false,
      );
      expect(isDefinitiveAuthFailure(new Error('socket hang up'))).to.equal(false);
    });
  });

  describe('MCP context', () => {
    it('re-resolves a dcd login session once it nears expiry', async () => {
      storeSession('token-a', 3600);
      const first = await getContext();
      expect(first.auth.headers.authorization).to.equal('Bearer token-a');

      // Another process (or a re-login) stores a newer session...
      storeSession('token-b', 3 * 3600);
      // ...which the server doesn't need while its own token is still good.
      expect((await getContext()).auth.headers.authorization).to.equal('Bearer token-a');

      // Two hours on, token-a has expired and the server picks up token-b.
      Date.now = () => realNow() + 2 * 3600 * 1000;
      const later = await getContext();
      expect(later.auth.headers.authorization).to.equal('Bearer token-b');
      expect(later.apiUrl).to.equal('https://api.devicecloud.dev');
    });

    it('resolves an API key once, whatever the time', async () => {
      process.env.DEVICE_CLOUD_API_KEY = 'mcp-key';
      const first = await getContext();
      Date.now = () => realNow() + 48 * 3600 * 1000;
      expect(await getContext()).to.equal(first);
      expect(first.auth.headers['x-app-api-key']).to.equal('mcp-key');
    });

    it('keeps failing, rather than caching, until the user logs in again', async () => {
      storeSession('token-a', 3600);
      await getContext();
      fs.rmSync(path.join(tempDir, 'config.json'), { force: true });
      Date.now = () => realNow() + 2 * 3600 * 1000;

      let caught: unknown;
      try {
        await getContext();
      } catch (error) {
        caught = error;
      }

      expect((caught as Error)?.message).to.match(/Not authenticated/);
      storeSession('after-relogin', 3 * 3600);
      expect((await getContext()).auth.headers.authorization).to.equal(
        'Bearer after-relogin',
      );
    });
  });

  describe('dcd cloud polling', () => {
    const passedRow = {
      id: 1,
      test_file_name: 'flow.yaml',
      status: 'PASSED',
      retry_of: null,
      duration_seconds: 1,
      fail_reason: null,
    };

    /** Record the headers of every poll and answer with a finished run. */
    function stubResults(): Array<Record<string, string>> {
      const seen: Array<Record<string, string>> = [];
      ApiGateway.getResultsForUpload = (async (_url: string, auth: AuthContext) => {
        seen.push({ ...auth.headers });
        return { results: [passedRow] };
      }) as unknown as typeof ApiGateway.getResultsForUpload;
      return seen;
    }

    /** Stand in for the Supabase socket and record the tokens it is handed. */
    function stubRealtime(): { joinedWith: string[]; updatedTo: string[] } {
      const calls = { joinedWith: [] as string[], updatedTo: [] as string[] };
      RealtimeResultsGateway.subscribe = (options) => {
        calls.joinedWith.push(options.accessToken);
        return {
          isConnected: () => false,
          async unsubscribe() {},
          updateAccessToken(token: string) {
            calls.updatedTo.push(token);
          },
        };
      };
      return calls;
    }

    const poll = (auth: AuthContext, service = new ResultsPollingService()) =>
      service.pollUntilComplete({
        auth,
        apiUrl: 'https://api.example.com',
        consoleUrl: 'https://console.example.com/results?upload=u1',
        json: true,
        uploadId: 'u1',
      });

    it('polls with a refreshed token, and hands it to the realtime socket', async () => {
      storeSession('fresh', 3600, '99');
      const seen = stubResults();
      const realtime = stubRealtime();

      const result = await poll(expiredBearer('stale', '42'));

      expect(result.status).to.equal('PASSED');
      expect(seen).to.deep.equal([{ authorization: 'Bearer fresh', 'x-dcd-org': '42' }]);
      expect(realtime.joinedWith).to.deep.equal(['stale']);
      expect(realtime.updatedTo).to.deep.equal(['fresh']);
    });

    it('leaves API-key polling exactly as it was', async () => {
      const seen = stubResults();
      await poll({ mode: 'apiKey', headers: { 'x-app-api-key': 'k' } });
      expect(seen).to.deep.equal([{ 'x-app-api-key': 'k' }]);
    });

    it('retries a refresh that failed on a network blip, like any failed poll', async () => {
      storeSession('stale', 10);
      stubRealtime();
      const seen = stubResults();
      let attempts = 0;
      CliAuthGateway.refresh = async () => {
        attempts++;
        if (attempts === 1) throw new SessionRefreshError('fetch failed', false);
        return {
          access_token: 'second-try',
          refresh_token: 'r2',
          expires_at: nowSeconds() + 3600,
          user_email: 'u@example.com',
          user_id: 'u1',
        };
      };
      const service = new ResultsPollingService();
      // Skip the real backoff between failed polls.
      (service as unknown as { sleep: () => Promise<void> }).sleep = async () => {};

      const result = await poll(expiredBearer('stale'), service);

      expect(result.status).to.equal('PASSED');
      expect(attempts).to.equal(2);
      expect(seen.map((h) => h.authorization)).to.deep.equal(['Bearer second-try']);
    });

    it('stops at once, with a reconnect hint, when only `dcd login` can help', async () => {
      storeSession('stale', 10);
      stubRealtime();
      const seen = stubResults();
      CliAuthGateway.refresh = async () => {
        throw new SessionRefreshError('Invalid Refresh Token: Already Used', true);
      };

      const started = realNow();
      let caught: unknown;
      try {
        await poll(expiredBearer('stale'));
      } catch (error) {
        caught = error;
      }

      expect(caught).to.be.instanceOf(PollingAuthError);
      expect((caught as Error).message).to.include('Invalid Refresh Token');
      expect((caught as Error).message).to.include('dcd login');
      expect((caught as Error).message).to.include('dcd status --upload-id u1');
      expect(seen).to.deep.equal([]);
      // No trip through the 30-attempt retry budget and its backoff.
      expect(realNow() - started).to.be.below(2000);
    });

    it('downloads the report after a long poll with a refreshed token', async () => {
      storeSession('fresh', 3600);
      const headers: Array<Record<string, string>> = [];
      (global as any).fetch = async (_input: unknown, init?: RequestInit) => {
        headers.push({ ...(init?.headers as Record<string, string>) });
        return new Response('<xml/>', { status: 200 });
      };

      await new ReportDownloadService().downloadReports({
        apiUrl: 'https://api.example.com',
        auth: expiredBearer('stale'),
        junitPath: path.join(tempDir, 'report.xml'),
        reportType: 'junit',
        uploadId: 'u1',
      });

      expect(headers[0].authorization).to.equal('Bearer fresh');
      expect(fs.readFileSync(path.join(tempDir, 'report.xml'), 'utf8')).to.equal('<xml/>');
    });
  });
});
