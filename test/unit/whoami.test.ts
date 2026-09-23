import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { whoamiCommand } from '../../src/commands/whoami.js';
import { apiKeyOverride } from '../../src/utils/auth.js';
import { writeConfig } from '../../src/utils/config-store.js';

/**
 * `whoami` shows the stored `dcd login` session, but every other command
 * authenticates with --api-key or DEVICE_CLOUD_API_KEY first — so it must say
 * when one of those is in play instead of implying the session is used.
 */
describe('dcd whoami', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-whoami-test-'));
    process.env.DCD_CONFIG_DIR = tempDir;
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

  /** Run whoami and return what it printed, without colour codes. */
  function whoami(args: Record<string, unknown> = {}): string {
    let out = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      (whoamiCommand.run as (ctx: { args: Record<string, unknown> }) => void)({ args });
    } finally {
      process.stdout.write = original;
    }

    return stripVTControlCharacters(out);
  }

  it('shows the session and nothing else when no API key is set', () => {
    logIn();
    const out = whoami();
    expect(out).to.include('u@example.com');
    expect(out).to.include('Acme');
    expect(out).to.not.match(/API key/);
  });

  it('warns that an exported DEVICE_CLOUD_API_KEY is what other commands use', () => {
    logIn();
    process.env.DEVICE_CLOUD_API_KEY = 'exported-key';
    const out = whoami();
    expect(out).to.include('u@example.com');
    expect(out).to.include(
      'DEVICE_CLOUD_API_KEY is set, so other dcd commands authenticate with that API key and its org, not this session.',
    );
  });

  it('warns about --api-key the same way', () => {
    logIn();
    const out = whoami({ 'api-key': 'flag-key' });
    expect(out).to.include(
      'Commands given --api-key authenticate with that API key and its org, not this session.',
    );
  });

  it('says a key will be used when nobody is logged in', () => {
    process.env.DEVICE_CLOUD_API_KEY = 'exported-key';
    expect(whoami()).to.include(
      'Not logged in. DEVICE_CLOUD_API_KEY is set, so dcd commands authenticate with that API key.',
    );
  });

  it('still points a logged-out user without a key at dcd login', () => {
    expect(whoami()).to.include('Not logged in. Run dcd login or set DEVICE_CLOUD_API_KEY.');
  });

  describe('apiKeyOverride', () => {
    it('follows resolveAuth: the flag, then the env var', () => {
      process.env.DEVICE_CLOUD_API_KEY = 'exported-key';
      expect(apiKeyOverride('flag-key')).to.equal('--api-key');
      expect(apiKeyOverride()).to.equal('DEVICE_CLOUD_API_KEY');
    });

    it('ignores blank values, as resolveAuth does', () => {
      process.env.DEVICE_CLOUD_API_KEY = '   ';
      expect(apiKeyOverride('  ')).to.equal(undefined);
    });
  });
});
