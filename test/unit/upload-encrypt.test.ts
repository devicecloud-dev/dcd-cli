import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { uploadCommand } from '../../src/commands/upload.js';
import { clearCompatibilityCache } from '../../src/utils/compatibility.js';

/**
 * `dcd upload` decides encryption in the same order as `dcd cloud`: the flag
 * (--encrypt / --no-encrypt), then DCD_ENCRYPT, then the org's default from
 * the compatibility data (dcd#1138), then off.
 *
 * Observed through the dedup lookup, which is the first upload request either
 * way: an encrypted upload deduplicates on the plaintext hash and says so
 * (`{ shaPlain, encrypted: true }`), a plaintext one sends `{ sha }`.
 */
const API = 'http://localhost:9999';
const APK = path.join(process.cwd(), 'test/fixtures/wikipedia.apk');

describe('dcd upload encryption', () => {
  const ORIGINAL_ENV = { ...process.env };
  const realFetch = globalThis.fetch;
  const realExit = process.exit;
  let lookups: Array<Record<string, unknown>>;
  /** The `encryption` field the mocked compatibility endpoint returns, if any. */
  let compatEncryption: { defaultOn: boolean } | undefined;
  let compatFails: boolean;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-upload-test-'));
    process.env.DCD_CONFIG_DIR = tempDir;
    process.env.DEVICE_CLOUD_API_KEY = 'test-key';
    delete process.env.DCD_ENCRYPT;
    delete process.env.DCD_ENCRYPT_BINARIES;
    clearCompatibilityCache();
    compatEncryption = undefined;
    compatFails = false;

    // A throwaway KEK so encryption can run without a pinned key.
    const { publicKey } = generateKeyPairSync('x25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    process.env.DCD_BINARY_KEK_PUBLIC = `1:${raw.toString('base64')}`;

    // Serve the compatibility data, and answer the dedup lookup with a hit of
    // the matching kind, so the command finishes without uploading anything.
    lookups = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
          status,
        });

      if (String(input).includes('/results/compatibility/data')) {
        if (compatFails) return json({ message: 'boom' }, 500);
        return json({
          data: {
            android: {},
            androidPlay: {},
            ios: {},
            maestro: { defaultVersion: '2.0.0', latestVersion: '2.0.0', supportedVersions: ['2.0.0'] },
            ...(compatEncryption ? { encryption: compatEncryption } : {}),
          },
          statusCode: 200,
        });
      }

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      lookups.push(body);
      return json({
        appBinaryId: body.encrypted ? 'encrypted-binary' : 'plain-binary',
        encrypted: Boolean(body.encrypted),
        exists: true,
      });
    }) as typeof fetch;

    // A failure must fail the test, not end the mocha process.
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.exit = realExit;
    process.env = { ...ORIGINAL_ENV };
    clearCompatibilityCache();
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  /** Run `dcd upload <apk>` with `args` and return everything it printed. */
  async function run(args: Record<string, unknown>): Promise<string> {
    let out = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      await (
        uploadCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>
      )({ args: { appFile: APK, 'api-url': API, ...args } });
    } finally {
      process.stdout.write = original;
    }

    return out;
  }

  /** Run `dcd upload --json <apk>` and return the binary id it printed. */
  async function upload(args: Record<string, unknown> = {}): Promise<string> {
    const out = await run({ json: true, ...args });
    return (JSON.parse(out) as { appBinaryId: string }).appBinaryId;
  }

  it('encrypts when DCD_ENCRYPT=1 is exported and --encrypt is not passed', async () => {
    process.env.DCD_ENCRYPT = '1';

    expect(await upload()).to.equal('encrypted-binary');
    expect(lookups[0]).to.include({ encrypted: true });
    expect(lookups[0]).to.have.property('shaPlain');
  });

  it('still encrypts with --encrypt alone', async () => {
    expect(await upload({ encrypt: true })).to.equal('encrypted-binary');
  });

  it('uploads in plaintext when neither is set and the API sends no default', async () => {
    expect(await upload()).to.equal('plain-binary');
    expect(lookups[0]).to.have.property('sha');
    expect(lookups[0]).to.not.have.property('encrypted');
  });

  it('uploads in plaintext when the org default is off', async () => {
    compatEncryption = { defaultOn: false };
    expect(await upload()).to.equal('plain-binary');
  });

  it('encrypts when the org default is on', async () => {
    compatEncryption = { defaultOn: true };
    expect(await upload()).to.equal('encrypted-binary');
  });

  it('lets --no-encrypt beat the org default', async () => {
    compatEncryption = { defaultOn: true };
    expect(await upload({ encrypt: false })).to.equal('plain-binary');
  });

  it('lets --no-encrypt beat DCD_ENCRYPT=1', async () => {
    process.env.DCD_ENCRYPT = '1';
    expect(await upload({ encrypt: false })).to.equal('plain-binary');
  });

  it('lets DCD_ENCRYPT=0 beat the org default', async () => {
    process.env.DCD_ENCRYPT = '0';
    compatEncryption = { defaultOn: true };
    expect(await upload()).to.equal('plain-binary');
  });

  it('treats a failed compatibility fetch as the default being off', async () => {
    compatFails = true;
    expect(await upload()).to.equal('plain-binary');
  });

  it('says the beta is on, and how to opt out, when the org default encrypts', async () => {
    compatEncryption = { defaultOn: true };
    expect(await run({})).to.contain(
      'Encrypting uploads (beta); opt out with --no-encrypt',
    );
  });

  it('says nothing about the beta when the flag or env var turned encryption on', async () => {
    compatEncryption = { defaultOn: true };
    expect(await run({ encrypt: true })).to.not.contain('(beta)');
    process.env.DCD_ENCRYPT = '1';
    expect(await run({})).to.not.contain('(beta)');
  });
});
