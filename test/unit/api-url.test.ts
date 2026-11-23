import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { checkApiUrl } from '../../src/utils/api-url.js';
import { CliError } from '../../src/utils/cli.js';
import { resolveApiUrl } from '../../src/utils/config-store.js';

/**
 * Your API key or login session goes with every request to the API URL, so
 * one given by hand (--api-url, DCD_API_URL) is checked before it is used.
 */
describe('an API URL given by hand', () => {
  const ORIGINAL_ENV = { ...process.env };
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-api-url-'));
    process.env.DCD_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(configDir, { force: true, recursive: true });
  });

  it('accepts DeviceCloud hosts, and plain http only to this machine', () => {
    expect(checkApiUrl('https://api.devicecloud.dev')).to.deep.equal({
      ok: true,
      origin: 'https://api.devicecloud.dev',
      warning: null,
    });
    expect(checkApiUrl('https://dev-api.devicecloud.dev/').ok).to.equal(true);
    for (const local of ['http://localhost:3001', 'http://127.0.0.1:3000', 'http://[::1]:8080', 'http://api.localhost']) {
      expect(checkApiUrl(local)).to.include({ ok: true, warning: null });
    }
  });

  it('refuses plain http elsewhere, a user name in the URL, another scheme, and text that is not a URL', () => {
    const reason = (url: string) => {
      const check = checkApiUrl(url);
      return check.ok ? '' : check.reason;
    };

    expect(reason('http://api.example.com')).to.include('over plain http');
    expect(reason('https://user:pass@api.devicecloud.dev')).to.include('user name or password');
    expect(reason('ftp://api.devicecloud.dev')).to.include('must start with https://');
    expect(reason('api.devicecloud.dev')).to.include('is not a URL');
  });

  it('warns about a host that is not devicecloud.dev, but allows it', () => {
    const check = checkApiUrl('https://api.example.com');
    expect(check.ok).to.equal(true);
    expect(check.ok && check.warning).to.include('not a devicecloud.dev host');
    // A name that only ends in the same letters is not ours.
    const lookalike = checkApiUrl('https://evildevicecloud.dev');
    expect(lookalike.ok).to.equal(true);
    expect(lookalike.ok && lookalike.warning).to.include('not a devicecloud.dev host');
  });

  it('resolveApiUrl refuses before anything is sent, and warns once per host on stderr', () => {
    expect(() => resolveApiUrl('http://api.example.com')).to.throw(CliError, 'over plain http');
    let stderr = '';
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(resolveApiUrl('https://staging.example.net')).to.equal('https://staging.example.net');
      expect(resolveApiUrl('https://staging.example.net/')).to.equal('https://staging.example.net/');
    } finally {
      process.stderr.write = write;
    }

    expect(stderr.split('not a devicecloud.dev host')).to.have.length(2);
  });
});
