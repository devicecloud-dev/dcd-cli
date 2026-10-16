import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { liveCommand } from '../../src/commands/live.js';
import { logoutCommand } from '../../src/commands/logout.js';
import { whoamiCommand } from '../../src/commands/whoami.js';
import { ApiGateway } from '../../src/gateways/api-gateway.js';
import type { LiveSession } from '../../src/types/domain/live.types.js';
import { wantsJson } from '../../src/utils/cli.js';
import { writeConfig } from '../../src/utils/config-store.js';

/**
 * Every command takes --json, and with it stdout must be exactly one JSON
 * object — scripts pipe it straight into a parser.
 */
describe('--json output', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-json-test-'));
    process.env.DCD_CONFIG_DIR = tempDir;
    process.env.DCD_TELEMETRY_DISABLED = '1';
    delete process.env.DEVICE_CLOUD_API_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  const logIn = () =>
    writeConfig({
      version: 1,
      env: 'prod',
      api_url: 'https://api.devicecloud.dev',
      supabase_url: 'https://cloud.devicecloud.dev',
      session: {
        access_token: 'a',
        refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_email: 'u@example.com',
        user_id: 'u1',
      },
      current_org_id: '42',
      current_org_name: 'Acme',
    });

  /** Run a command's `run` and parse stdout, which must be a single JSON value. */
  async function runJson(
    run: unknown,
    ctx: { args?: Record<string, unknown>; rawArgs?: string[] },
  ): Promise<Record<string, unknown>> {
    let out = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      await (run as (c: typeof ctx) => Promise<void> | void)({ args: {}, rawArgs: [], ...ctx });
    } finally {
      process.stdout.write = original;
    }

    return JSON.parse(out) as Record<string, unknown>;
  }

  describe('wantsJson', () => {
    it('spots --json anywhere in argv', () => {
      expect(wantsJson(['whoami', '--json'])).to.equal(true);
      expect(wantsJson(['--json=true', 'logout'])).to.equal(true);
    });

    it('ignores look-alike flags', () => {
      expect(wantsJson(['cloud', '--json-file'])).to.equal(false);
      expect(wantsJson(['whoami'])).to.equal(false);
    });
  });

  describe('dcd whoami --json', () => {
    it('reports the session', async () => {
      logIn();
      expect(await runJson(whoamiCommand.run, { args: { json: true } })).to.deep.equal({
        status: 'SUCCESS',
        loggedIn: true,
        user: 'u@example.com',
        org: { id: '42', name: 'Acme' },
        env: 'prod',
        apiKeySource: null,
      });
    });

    it('reports an exported API key', async () => {
      logIn();
      process.env.DEVICE_CLOUD_API_KEY = 'exported-key';
      const out = await runJson(whoamiCommand.run, { args: { json: true } });
      expect(out.apiKeySource).to.equal('DEVICE_CLOUD_API_KEY');
    });

    it('reports being logged out', async () => {
      expect(await runJson(whoamiCommand.run, { args: { json: true } })).to.deep.equal({
        status: 'SUCCESS',
        loggedIn: false,
        apiKeySource: null,
      });
    });
  });

  describe('dcd logout --json', () => {
    it('says nothing was logged out when there is no session', async () => {
      expect(await runJson(logoutCommand.run, { args: { json: true } })).to.deep.equal({
        status: 'SUCCESS',
        loggedOut: false,
      });
    });
  });

  describe('dcd live --json', () => {
    const originalGet = ApiGateway.getLiveSession;
    const originalStop = ApiGateway.stopLiveSession;
    const liveArgs = { 'api-key': 'k', 'api-url': 'https://api.example.com', json: true };
    const sub = (name: string) =>
      (liveCommand.subCommands as Record<string, { run: unknown }>)[name].run;

    afterEach(() => {
      ApiGateway.getLiveSession = originalGet;
      ApiGateway.stopLiveSession = originalStop;
    });

    it('lists the subcommands from the bare menu', async () => {
      const out = await runJson(liveCommand.run, { rawArgs: ['--json'] });
      const names = (out.commands as { name: string }[]).map((c) => c.name);
      expect(names).to.include.members(['start', 'run', 'status', 'stop']);
    });

    it('status prints the session without the heavy payloads', async () => {
      ApiGateway.getLiveSession = async () =>
        ({
          session_name: 's1',
          platform: 'android',
          status: 'RUNNING',
          ready: true,
          created_at: '2026-01-01T00:00:00Z',
          screenshot_data_url: 'data:image/png;base64,AAAA',
          hierarchy: { width: 1, height: 1, elements: [] },
        }) as unknown as LiveSession;

      const out = await runJson(sub('status'), { args: { ...liveArgs, session: 's1' } });
      expect(out).to.include({ session_name: 's1', status: 'RUNNING', ready: true });
      expect(out).to.not.have.property('screenshot_data_url');
      expect(out).to.not.have.property('hierarchy');
    });

    it('hierarchy --output writes the file and prints only a result object', async () => {
      const hierarchy = { width: 1, height: 1, elements: [] };
      ApiGateway.getLiveSession = async () =>
        ({ session_name: 's1', hierarchy }) as unknown as LiveSession;
      const file = path.join(tempDir, 'hierarchy.json');

      expect(
        await runJson(sub('hierarchy'), { args: { ...liveArgs, session: 's1', output: file } }),
      ).to.deep.equal({ status: 'SUCCESS', path: file });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).to.deep.equal(hierarchy);
    });

    it('stop prints only the result object', async () => {
      ApiGateway.stopLiveSession = async () => {};
      expect(
        await runJson(sub('stop'), { args: { ...liveArgs, session: 's1' } }),
      ).to.deep.equal({ status: 'SUCCESS', session: 's1' });
    });
  });
});
