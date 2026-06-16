import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveAuth } from '../../src/utils/auth';
import {
  clearConfig,
  configFileMode,
  getConfigPath,
  readConfig,
  resolveApiUrl,
  writeConfig,
} from '../../src/utils/config-store';

const ORIGINAL_ENV = { ...process.env };

function withTempConfigDir<T>(fn: () => T | Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-auth-test-'));
  process.env.DCD_CONFIG_DIR = tmp;
  return Promise.resolve(fn()).finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    if (ORIGINAL_ENV.DCD_CONFIG_DIR) {
      process.env.DCD_CONFIG_DIR = ORIGINAL_ENV.DCD_CONFIG_DIR;
    } else {
      delete process.env.DCD_CONFIG_DIR;
    }
  });
}

describe('config-store', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('writes a file with 0600 permissions in the chosen dir', async () => {
    if (process.platform === 'win32') return; // permission bits are meaningless on Windows
    await withTempConfigDir(() => {
      writeConfig({
        version: 1,
        env: 'prod',
        api_url: 'https://api.devicecloud.dev',
        supabase_url: 'https://cloud.devicecloud.dev',
      });
      const mode = configFileMode();
      expect(mode).to.equal(0o600);
      expect(fs.existsSync(getConfigPath())).to.equal(true);
    });
  });

  it('readConfig returns null when no file exists', async () => {
    await withTempConfigDir(() => {
      expect(readConfig()).to.equal(null);
    });
  });

  it('clearConfig removes the stored file', async () => {
    await withTempConfigDir(() => {
      writeConfig({
        version: 1,
        env: 'prod',
        api_url: 'https://api.devicecloud.dev',
        supabase_url: 'https://cloud.devicecloud.dev',
      });
      clearConfig();
      expect(readConfig()).to.equal(null);
    });
  });
});

// Regression coverage for #16: session commands must honor the api_url stored
// by `dcd login` instead of always defaulting to prod, otherwise a dev/staging
// Bearer token is sent to prod and rejected as "Invalid or expired JWT".
describe('resolveApiUrl precedence', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('prefers an explicit flag over the stored config', async () => {
    await withTempConfigDir(() => {
      writeConfig({
        version: 1,
        env: 'dev',
        api_url: 'https://api.dev.devicecloud.dev',
        supabase_url: 'https://lbmsowehtjwnqlurpemb.supabase.co',
      });
      expect(resolveApiUrl('https://api.devicecloud.dev')).to.equal(
        'https://api.devicecloud.dev',
      );
    });
  });

  it('falls back to the stored api_url when no flag is given', async () => {
    await withTempConfigDir(() => {
      writeConfig({
        version: 1,
        env: 'dev',
        api_url: 'https://api.dev.devicecloud.dev',
        supabase_url: 'https://lbmsowehtjwnqlurpemb.supabase.co',
      });
      expect(resolveApiUrl(undefined)).to.equal('https://api.dev.devicecloud.dev');
      // A blank/whitespace flag is treated as "not provided".
      expect(resolveApiUrl('   ')).to.equal('https://api.dev.devicecloud.dev');
    });
  });

  it('defaults to prod when neither a flag nor a stored config exists', async () => {
    await withTempConfigDir(() => {
      expect(resolveApiUrl(undefined)).to.equal('https://api.devicecloud.dev');
    });
  });
});

describe('resolveAuth precedence', () => {
  beforeEach(() => {
    delete process.env.DEVICE_CLOUD_API_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('prefers --api-key flag over env var and stored session', async () => {
    await withTempConfigDir(async () => {
      process.env.DEVICE_CLOUD_API_KEY = 'env-key';
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
      });

      const auth = await resolveAuth({ apiKeyFlag: 'flag-key' });
      expect(auth.mode).to.equal('apiKey');
      expect(auth.headers['x-app-api-key']).to.equal('flag-key');
    });
  });

  it('falls back to DEVICE_CLOUD_API_KEY env var when no flag given', async () => {
    await withTempConfigDir(async () => {
      process.env.DEVICE_CLOUD_API_KEY = 'env-key';
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
      });

      const auth = await resolveAuth({ apiKeyFlag: undefined });
      expect(auth.mode).to.equal('apiKey');
      expect(auth.headers['x-app-api-key']).to.equal('env-key');
    });
  });

  it('throws when no credentials of any kind are available', async () => {
    await withTempConfigDir(async () => {
      let caught: Error | null = null;
      try {
        await resolveAuth({ apiKeyFlag: undefined });
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).to.not.equal(null);
      expect(caught!.message).to.match(/api key|DEVICE_CLOUD_API_KEY|dcd login/i);
    });
  });

  it('uses a non-expired stored session as a last resort', async () => {
    await withTempConfigDir(async () => {
      writeConfig({
        version: 1,
        env: 'prod',
        api_url: 'https://api.devicecloud.dev',
        supabase_url: 'https://cloud.devicecloud.dev',
        session: {
          access_token: 'bearer-token',
          refresh_token: 'refresh',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user_email: 'u@example.com',
          user_id: 'u1',
        },
        current_org_id: '42',
      });

      const auth = await resolveAuth({ apiKeyFlag: undefined });
      expect(auth.mode).to.equal('bearer');
      expect(auth.headers.authorization).to.equal('Bearer bearer-token');
      expect(auth.headers['x-dcd-org']).to.equal('42');
    });
  });
});
