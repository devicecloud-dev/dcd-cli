import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { uploadCommand } from '../../src/commands/upload.js';

/**
 * `dcd upload` must honour DCD_ENCRYPT=1 exactly as `dcd cloud` does. It used
 * to pass `Boolean(args.encrypt)`, and an explicit `false` beats the env var,
 * so an exported DCD_ENCRYPT=1 was silently ignored and the binary went up in
 * plaintext.
 *
 * Observed through the dedup lookup, which is the first request either way:
 * an encrypted upload deduplicates on the plaintext hash and says so
 * (`{ shaPlain, encrypted: true }`), a plaintext one sends `{ sha }`.
 */
const API = 'http://localhost:9999';
const APK = path.join(process.cwd(), 'test/fixtures/wikipedia.apk');

describe('dcd upload encryption', () => {
  const ORIGINAL_ENV = { ...process.env };
  const realFetch = globalThis.fetch;
  const realExit = process.exit;
  let lookups: Array<Record<string, unknown>>;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-upload-test-'));
    process.env.DCD_CONFIG_DIR = tempDir;
    process.env.DEVICE_CLOUD_API_KEY = 'test-key';
    delete process.env.DCD_ENCRYPT;
    delete process.env.DCD_ENCRYPT_BINARIES;

    // A throwaway KEK so encryption can run without a pinned key.
    const { publicKey } = generateKeyPairSync('x25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    process.env.DCD_BINARY_KEK_PUBLIC = `1:${raw.toString('base64')}`;

    // Answer the dedup lookup with a hit of the matching kind, so the command
    // finishes without uploading anything.
    lookups = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      lookups.push(body);
      return new Response(
        JSON.stringify({
          appBinaryId: body.encrypted ? 'encrypted-binary' : 'plain-binary',
          encrypted: Boolean(body.encrypted),
          exists: true,
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
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
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  /** Run `dcd upload --json <apk>` and return the binary id it printed. */
  async function upload(args: Record<string, unknown> = {}): Promise<string> {
    let out = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      await (
        uploadCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>
      )({ args: { appFile: APK, 'api-url': API, json: true, ...args } });
    } finally {
      process.stdout.write = original;
    }

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

  it('uploads in plaintext when neither is set', async () => {
    expect(await upload()).to.equal('plain-binary');
    expect(lookups[0]).to.have.property('sha');
    expect(lookups[0]).to.not.have.property('encrypted');
  });
});
