import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ApiGateway } from '../../src/gateways/api-gateway.js';
import { uploadBinary } from '../../src/methods.js';
import type { AuthContext } from '../../src/types/domain/auth.types.js';

/**
 * Dedup for client-side encrypted binaries (dcd#1168).
 *
 * Encryption uses a fresh random DEK per upload, so the ciphertext hash differs
 * every time and cannot serve as a dedup key. The CLI therefore hashes the
 * PLAINTEXT first, deduplicates on that, and only encrypts on a miss.
 *
 * The security-critical half is the invariant check: a plaintext row has the same
 * plaintext hash as its encrypted twin, so a dedup hit must be rejected unless
 * the server confirms the matched binary is itself encrypted.
 */

const TEST_AUTH: AuthContext = {
  mode: 'apiKey',
  headers: { 'x-app-api-key': 'test-key' },
};

const API = 'http://localhost:9999';
const APK = path.join(process.cwd(), 'test/fixtures/wikipedia.apk');

const originalFetch = (global as any).fetch;

type Call = { body: unknown; url: string };

/**
 * Mock global.fetch with a per-endpoint handler map, recording every call.
 * Any endpoint without a handler resolves to a 500 carrying a marker string, so
 * a test can assert control reached it.
 * @param handlers Map of URL substring to a response factory
 * @returns The recorded call list
 */
function mockFetch(
  handlers: Record<string, () => { body: unknown; status: number }>,
): Call[] {
  const calls: Call[] = [];
  (global as any).fetch = async (
    input: URL | string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input.toString();
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      url,
    });

    const key = Object.keys(handlers).find((k) => url.includes(k));
    const { body, status } = key
      ? handlers[key]()
      : { body: { message: 'REACHED_UPLOAD_PATH' }, status: 500 };

    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      status,
    });
  };
  return calls;
}

/** A throwaway X25519 public key so encryption can run without a pinned KEK. */
function setTestKek() {
  const { publicKey } = generateKeyPairSync('x25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  process.env.DCD_BINARY_KEK_PUBLIC = `1:${raw.toString('base64')}`;
}

describe('encrypted binary dedup (#1168)', () => {
  afterEach(() => {
    (global as any).fetch = originalFetch;
    delete process.env.DCD_BINARY_KEK_PUBLIC;
  });

  describe('ApiGateway.checkForExistingUpload wire format', () => {
    it('sends shaPlain + encrypted (and NOT sha) for an encrypted lookup', async () => {
      const calls = mockFetch({
        checkForExistingUpload: () => ({
          body: { appBinaryId: 'enc-binary', encrypted: true, exists: true },
          status: 200,
        }),
      });

      const res = await ApiGateway.checkForExistingUpload(API, TEST_AUTH, {
        encrypted: true,
        shaPlain: 'plain-hash',
      });

      expect(calls[0].body).to.deep.equal({
        encrypted: true,
        shaPlain: 'plain-hash',
      });
      // The ciphertext hash is not known at dedup time and must not be implied.
      expect(calls[0].body).to.not.have.property('sha');
      expect(res.encrypted).to.equal(true);
      expect(res.appBinaryId).to.equal('enc-binary');
    });

    it('sends a bare sha for an unencrypted lookup', async () => {
      const calls = mockFetch({
        checkForExistingUpload: () => ({
          body: { appBinaryId: 'plain-binary', encrypted: false, exists: true },
          status: 200,
        }),
      });

      await ApiGateway.checkForExistingUpload(API, TEST_AUTH, {
        sha: 'cipher-or-plain-hash',
      });

      expect(calls[0].body).to.deep.equal({ sha: 'cipher-or-plain-hash' });
    });

    it('still accepts a bare string sha (back-compat with the old signature)', async () => {
      const calls = mockFetch({
        checkForExistingUpload: () => ({
          body: { appBinaryId: 'b', exists: true },
          status: 200,
        }),
      });

      await ApiGateway.checkForExistingUpload(API, TEST_AUTH, 'legacy-sha');

      expect(calls[0].body).to.deep.equal({ sha: 'legacy-sha' });
    });
  });

  describe('uploadBinary dedup behaviour', () => {
    it('reuses an encrypted match without encrypting or uploading', async () => {
      setTestKek();
      const calls = mockFetch({
        checkForExistingUpload: () => ({
          body: { appBinaryId: 'enc-binary', encrypted: true, exists: true },
          status: 200,
        }),
      });

      const id = await uploadBinary({
        apiUrl: API,
        auth: TEST_AUTH,
        encrypt: true,
        filePath: APK,
        log: false,
      });

      expect(id).to.equal('enc-binary');
      // Nothing beyond the dedup check should have been attempted.
      expect(calls).to.have.lengthOf(1);
      expect(calls[0].url).to.contain('checkForExistingUpload');
    });

    it('REJECTS a plaintext match when encryption was requested', async () => {
      // The trap: the plaintext row has the same plaintext hash, so the server
      // could answer with it. Honouring that hit would return an unencrypted
      // binary to a caller who asked for encryption.
      setTestKek();
      const calls = mockFetch({
        checkForExistingUpload: () => ({
          body: { appBinaryId: 'plain-binary', encrypted: false, exists: true },
          status: 200,
        }),
      });

      let returned: string | undefined;
      try {
        returned = await uploadBinary({
          apiUrl: API,
          auth: TEST_AUTH,
          encrypt: true,
          filePath: APK,
          log: false,
        });
      } catch {
        // The mocked upload path fails; reaching it at all is the assertion.
      }

      // Proceeded past dedup into the upload path rather than silently handing
      // back the unencrypted binary.
      expect(returned).to.equal(undefined);
      expect(calls.some((c) => c.url.includes('getBinaryUploadUrl'))).to.equal(
        true,
      );
    });

    it('also rejects a hit when the server omits the encrypted field entirely', async () => {
      // An older deployment predating #1168 has no encryption predicate on the
      // lookup, so the absence of confirmation must be treated as a miss.
      setTestKek();
      const calls = mockFetch({
        checkForExistingUpload: () => ({
          body: { appBinaryId: 'unknown-binary', exists: true },
          status: 200,
        }),
      });

      let returned: string | undefined;
      try {
        returned = await uploadBinary({
          apiUrl: API,
          auth: TEST_AUTH,
          encrypt: true,
          filePath: APK,
          log: false,
        });
      } catch {
        // As above — the mocked upload path fails by design.
      }

      expect(returned).to.equal(undefined);
      expect(calls.some((c) => c.url.includes('getBinaryUploadUrl'))).to.equal(
        true,
      );
    });

    it('dedups on the plaintext hash, so the key is stable across encrypted runs', async () => {
      setTestKek();
      const seen: unknown[] = [];
      mockFetch({
        checkForExistingUpload: () => ({
          body: { appBinaryId: 'enc-binary', encrypted: true, exists: true },
          status: 200,
        }),
      });

      for (let i = 0; i < 2; i++) {

        await uploadBinary({
          apiUrl: API,
          auth: TEST_AUTH,
          encrypt: true,
          filePath: APK,
          log: false,
        });
      }

      // Reset and capture the lookup keys from two independent invocations.
      const calls = mockFetch({
        checkForExistingUpload: () => ({
          body: { appBinaryId: 'enc-binary', encrypted: true, exists: true },
          status: 200,
        }),
      });
      await uploadBinary({
        apiUrl: API,
        auth: TEST_AUTH,
        encrypt: true,
        filePath: APK,
        log: false,
      });
      await uploadBinary({
        apiUrl: API,
        auth: TEST_AUTH,
        encrypt: true,
        filePath: APK,
        log: false,
      });
      for (const c of calls) {
        seen.push((c.body as { shaPlain?: string }).shaPlain);
      }

      expect(seen).to.have.lengthOf(2);
      expect(seen[0]).to.be.a('string');
      // Identical input ⇒ identical lookup key, which is the whole point: the
      // ciphertext hash would have differed on every run.
      expect(seen[0]).to.equal(seen[1]);
    });

    it('leaves the unencrypted path deduping on the sha exactly as before', async () => {
      const calls = mockFetch({
        checkForExistingUpload: () => ({
          body: { appBinaryId: 'plain-binary', encrypted: false, exists: true },
          status: 200,
        }),
      });

      const id = await uploadBinary({
        apiUrl: API,
        auth: TEST_AUTH,
        encrypt: false,
        filePath: APK,
        log: false,
      });

      expect(id).to.equal('plain-binary');
      expect(calls[0].body).to.have.property('sha');
      expect(calls[0].body).to.not.have.property('encrypted');
      expect(calls[0].body).to.not.have.property('shaPlain');
    });

    it('honours --ignore-sha-check by skipping the lookup altogether', async () => {
      setTestKek();
      const calls = mockFetch({});

      try {
        await uploadBinary({
          apiUrl: API,
          auth: TEST_AUTH,
          encrypt: true,
          filePath: APK,
          ignoreShaCheck: true,
          log: false,
        });
      } catch {
        // Upload path is mocked to fail; only the absence of a lookup matters.
      }

      expect(calls.some((c) => c.url.includes('checkForExistingUpload'))).to.equal(
        false,
      );
    });
  });

  describe('finalise payload', () => {
    it('sends sha (ciphertext) alongside shaPlain for an encrypted upload', async () => {
      const calls = mockFetch({
        finaliseUpload: () => ({ body: {}, status: 200 }),
      });

      await ApiGateway.finaliseUpload({
        auth: TEST_AUTH,
        backblazeSuccess: true,
        baseUrl: API,
        bytes: 10,
        id: 'upload-id',

        metadata: {} as any,
        path: 'p',
        sha: 'ciphertext-hash',
        shaPlain: 'plaintext-hash',
        supabaseSuccess: true,
      });

      expect(calls[0].body).to.include({
        sha: 'ciphertext-hash',
        shaPlain: 'plaintext-hash',
      });
    });

    it('omits shaPlain for an unencrypted upload', async () => {
      const calls = mockFetch({
        finaliseUpload: () => ({ body: {}, status: 200 }),
      });

      await ApiGateway.finaliseUpload({
        auth: TEST_AUTH,
        backblazeSuccess: true,
        baseUrl: API,
        bytes: 10,
        id: 'upload-id',

        metadata: {} as any,
        path: 'p',
        sha: 'plain-hash',
        supabaseSuccess: true,
      });

      expect(calls[0].body).to.not.have.property('shaPlain');
    });
  });
});

// Keep the fixture path assumption honest — every uploadBinary case depends on it.
describe('encrypted dedup test fixture', () => {
  it('has the wikipedia.apk fixture available', () => {
    expect(fs.existsSync(APK), `missing fixture: ${APK}`).to.equal(true);
    expect(os.tmpdir()).to.be.a('string');
  });
});
