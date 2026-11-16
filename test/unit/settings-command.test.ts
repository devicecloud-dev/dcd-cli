import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { settingsCommand } from '../../src/commands/settings.js';
import type { TeamSettings } from '../../src/types/domain/team-settings.types.js';
import { writeConfig } from '../../src/utils/config-store.js';

const API = 'https://api.devicecloud.dev';

/** What the API returns to an owner, an admin or an org API key. */
export const OWNER_SETTINGS: TeamSettings = {
  orgId: 7,
  name: 'Acme',
  restricted: false,
  concurrency: {
    runners: [
      { platform: 'ios', runnerType: 'm4', min: 0, max: 2 },
      { platform: 'android', runnerType: 'gpu1', min: 0, max: 0 },
    ],
    pools: [
      {
        name: 'standard',
        min: 2,
        max: 12,
        members: [
          { platform: 'ios', runnerType: 'default' },
          { platform: 'android', runnerType: 'cpu1' },
        ],
      },
    ],
  },
  testRuntime: { defaultMinutes: 10, extendedMinutes: 20 },
  integrations: { webhook: true, slack: false, github: true },
  signInRequirement: 'passkey',
  retryEscalation: { available: true, target: 'm1', enabled: true },
  overage: { hasSubscription: true, limitUsd: 200 },
};

/** What a standard member gets. */
const STANDARD_SETTINGS: TeamSettings = {
  ...OWNER_SETTINGS,
  restricted: true,
  signInRequirement: null,
  retryEscalation: null,
  overage: null,
};

interface Call {
  headers: Record<string, string>;
  method: string;
  url: string;
}

function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** Run `dcd settings`, capturing stdout and the exit code. */
async function run(args: Record<string, unknown>): Promise<{ exit: number; out: string }> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  const exit = process.exit;
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  console.log = (...parts: unknown[]) => {
    out += parts.join(' ') + '\n';
  };
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
  let code = 0;
  try {
    await (settingsCommand.run as (c: unknown) => Promise<void>)({
      args: { 'api-url': API, ...args },
      rawArgs: [],
    });
  } catch (error) {
    if (!(error instanceof ExitError)) throw error;
    code = error.code;
  } finally {
    process.stdout.write = write;
    console.log = log;
    process.exit = exit;
  }

  return { exit: code, out: stripVTControlCharacters(out) };
}

describe('dcd settings', () => {
  const realFetch = globalThis.fetch;
  const ORIGINAL_ENV = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-settings-test-'));
    process.env.DCD_CONFIG_DIR = tempDir;
    process.env.DCD_TELEMETRY_DISABLED = '1';
    delete process.env.DEVICE_CLOUD_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it('reads GET /org/settings with the API key and prints it as-is with --json', async () => {
    const calls = stubFetch(200, OWNER_SETTINGS);

    const { exit, out } = await run({ 'api-key': 'k', json: true });

    expect(exit).to.equal(0);
    expect(JSON.parse(out)).to.deep.equal(OWNER_SETTINGS);
    expect(calls).to.have.length(1);
    expect(calls[0].url).to.equal(`${API}/org/settings`);
    expect(calls[0].method).to.equal('GET');
    expect(calls[0].headers['x-app-api-key']).to.equal('k');
  });

  it('uses the dcd login session and its org when there is no API key', async () => {
    writeConfig({
      version: 1,
      env: 'prod',
      api_url: API,
      supabase_url: 'https://cloud.devicecloud.dev',
      session: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_email: 'u@example.com',
        user_id: 'u1',
      },
      current_org_id: '7',
      current_org_name: 'Acme',
    });
    const calls = stubFetch(200, OWNER_SETTINGS);

    const { exit } = await run({ json: true });

    expect(exit).to.equal(0);
    expect(calls[0].headers.authorization).to.equal('Bearer access');
    expect(calls[0].headers['x-dcd-org']).to.equal('7');
    expect(calls[0].headers).not.to.have.property('x-app-api-key');
  });

  it('prints every section for an owner', async () => {
    stubFetch(200, OWNER_SETTINGS);

    const { exit, out } = await run({ 'api-key': 'k' });

    expect(exit).to.equal(0);
    for (const expected of [
      'Team',
      'Acme',
      'sign-in requirement   a passkey',
      'iOS m4',
      'min 0 · max 2',
      'Android gpu1',
      'not enabled',
      'standard pool',
      'min 2 · max 12',
      'standard pool is shared by iOS default and Android cpu1',
      '10 min per flow',
      '20 min per flow with EXTENDED_RUNTIME',
      'on · Android retries move to M1 runners',
      '$200 per billing period, on top of included credits',
      'webhook   connected',
      'slack     not connected',
      'github    connected',
    ]) {
      expect(out).to.include(expected);
    }
    expect(out).not.to.include('owner or admin only');
  });

  it('marks the owner/admin settings for a standard member instead of showing them as off', async () => {
    stubFetch(200, STANDARD_SETTINGS);

    const { exit, out } = await run({ 'api-key': 'k' });

    expect(exit).to.equal(0);
    expect(out.match(/owner or admin only/g)).to.have.length(3);
    expect(out).to.include('Some settings are shown to team owners and admins only.');
  });

  it('describes the empty states', async () => {
    stubFetch(200, {
      ...OWNER_SETTINGS,
      name: null,
      testRuntime: { defaultMinutes: 10, extendedMinutes: null },
      retryEscalation: { available: false, target: null, enabled: false },
      overage: { hasSubscription: true, limitUsd: null },
      concurrency: { runners: [], pools: [] },
    });

    const { out } = await run({ 'api-key': 'k' });

    expect(out).to.include('(unnamed)');
    expect(out).to.match(/extended\s+off/);
    expect(out).to.include('retry escalation   not available');
    expect(out).to.include('overage limit      uncapped');
    expect(out).to.match(/Concurrency\n\s+⎿ none/);
  });

  it('says so when the API predates the endpoint', async () => {
    stubFetch(404, { message: 'Cannot GET /org/settings' });

    const { exit, out } = await run({ 'api-key': 'k', json: true });

    expect(exit).to.equal(1);
    const body = JSON.parse(out);
    expect(body.status).to.equal('FAILED');
    expect(body.error).to.include("doesn't support reading team settings yet");
  });

  it('passes a 403 through, e.g. for a key scoped to device sessions', async () => {
    stubFetch(403, { message: 'This API key is limited to device sessions', error: 'API_KEY_SCOPE' });

    const { exit, out } = await run({ 'api-key': 'k', json: true });

    expect(exit).to.equal(1);
    expect(JSON.parse(out).error).to.include('This API key is limited to device sessions');
  });
});
