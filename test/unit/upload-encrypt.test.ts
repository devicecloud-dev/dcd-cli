import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { uploadCommand } from '../../src/commands/upload.js';
import { telemetry } from '../../src/services/telemetry.service.js';
import { resetCliConfigCache } from '../../src/config/cli-config.js';
import { clearCompatibilityCache } from '../../src/utils/compatibility.js';

/**
 * `dcd upload` always encrypts, like `dcd cloud` (dcd#1138). --no-encrypt and
 * DCD_ENCRYPT=0 are ignored with a warning. The only way to get a plaintext
 * upload is an API that publishes no KEK.
 *
 * Observed through the dedup lookup, which is the first upload request either
 * way: an encrypted upload deduplicates on the plaintext hash and says so
 * (`{ shaPlain, encrypted: true }`), a plaintext one sends `{ sha }`.
 */
const API = 'http://localhost:9999';
/** An API that publishes no KEK on /cli-config (see the fetch stub). */
const UNKNOWN_API = 'https://api.example.com';
const APK = path.join(process.cwd(), 'test/fixtures/wikipedia.apk');

describe('dcd upload encryption', () => {
  const ORIGINAL_ENV = { ...process.env };
  const realFetch = globalThis.fetch;
  const realExit = process.exit;
  const realFlushSync = telemetry.flushSync;
  let lookups: Array<Record<string, unknown>>;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-upload-test-'));
    process.env.DCD_CONFIG_DIR = tempDir;
    process.env.DEVICE_CLOUD_API_KEY = 'test-key';
    delete process.env.DCD_ENCRYPT;
    delete process.env.DCD_ENCRYPT_BINARIES;
    clearCompatibilityCache();
    resetCliConfigCache();

    // A throwaway KEK so encryption can run against an API that publishes none.
    const { publicKey } = generateKeyPairSync('x25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    process.env.DCD_BINARY_KEK_PUBLIC = `1:${raw.toString('base64')}`;

    // Answer the dedup lookup with a hit of the matching kind, so the command
    // finishes without uploading anything. `dcd upload` no longer reads the
    // compatibility data, so any request for it fails the test.
    lookups = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
          status,
        });

      // The API publishes no KEK here; the tests that encrypt set the
      // DCD_BINARY_KEK_PUBLIC override instead.
      if (String(input).endsWith('/cli-config')) {
        return json({ supabase_publishable_key: 'sb_publishable_test' });
      }

      if (String(input).includes('/results/compatibility/data')) {
        throw new Error('dcd upload should not fetch the compatibility data');
      }

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      lookups.push(body);
      return json({
        appBinaryId: body.encrypted ? 'encrypted-binary' : 'plain-binary',
        encrypted: Boolean(body.encrypted),
        exists: true,
      });
    }) as typeof fetch;

    // A failure must fail the test, not end the mocha process, and must not
    // ship failure telemetry to the real API on its way out.
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    telemetry.flushSync = () => {};
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.exit = realExit;
    telemetry.flushSync = realFlushSync;
    process.env = { ...ORIGINAL_ENV };
    clearCompatibilityCache();
    resetCliConfigCache();
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

  it('encrypts with nothing set', async () => {
    expect(await upload()).to.equal('encrypted-binary');
    expect(lookups[0]).to.include({ encrypted: true });
    expect(lookups[0]).to.have.property('shaPlain');
  });

  it('encrypts with --encrypt, which is now a no-op', async () => {
    expect(await upload({ encrypt: true })).to.equal('encrypted-binary');
  });

  it('ignores --no-encrypt, with a warning, and still encrypts', async () => {
    expect(await upload({ encrypt: false })).to.equal('encrypted-binary');
    expect(await run({ encrypt: false })).to.contain(
      'Ignoring --no-encrypt: uploads are always encrypted.',
    );
  });

  for (const name of ['DCD_ENCRYPT', 'DCD_ENCRYPT_BINARIES']) {
    it(`ignores ${name}=0, with a warning, and still encrypts`, async () => {
      process.env[name] = '0';
      expect(await upload()).to.equal('encrypted-binary');
      expect(await run({})).to.contain(`Ignoring ${name}: uploads are always encrypted.`);
    });
  }

  it('prints no notice in the normal case', async () => {
    expect(await run({})).to.not.contain('Ignoring');
  });

  describe('against an API that publishes no KEK', () => {
    beforeEach(() => {
      delete process.env.DCD_BINARY_KEK_PUBLIC;
    });

    it('uploads in plaintext, with a notice', async () => {
      expect(await upload({ 'api-url': UNKNOWN_API })).to.equal('plain-binary');
      expect(lookups[0]).to.have.property('sha');
      expect(lookups[0]).to.not.have.property('encrypted');
      const out = await run({ 'api-url': UNKNOWN_API });
      expect(out).to.contain(`Not encrypting uploads: ${UNKNOWN_API}`);
    });

    it('treats --encrypt the same way, since it is a no-op', async () => {
      expect(await upload({ 'api-url': UNKNOWN_API, encrypt: true })).to.equal('plain-binary');
    });

    it('encrypts once DCD_BINARY_KEK_PUBLIC names a key', async () => {
      const { publicKey } = generateKeyPairSync('x25519');
      const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
      process.env.DCD_BINARY_KEK_PUBLIC = `1:${raw.toString('base64')}`;
      expect(await upload({ 'api-url': UNKNOWN_API })).to.equal('encrypted-binary');
    });
  });
});
