import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import StreamZip from 'node-stream-zip';
import * as yazl from 'yazl';

import { SupabaseGateway } from '../../src/gateways/supabase-gateway.js';
import { uploadBinary } from '../../src/methods.js';
import {
  detectFlutterEngine,
  FLUTTER_ENGINE_ENTRY,
} from '../../src/services/metadata-extractor.service.js';
import type { AuthContext } from '../../src/types/domain/auth.types.js';

/**
 * The API picks the emulator renderer from `usesFlutterEngine`, which it
 * detects by finding `lib/x86_64/libflutter.so` in a stored APK. It can't
 * look inside an encrypted APK, so the CLI detects it from the plaintext and
 * sends it with the envelope (dcd#1138).
 */
const WIKIPEDIA_APK = path.resolve('test/fixtures/wikipedia.apk');
const API = 'http://localhost:9999';
const TEST_AUTH: AuthContext = {
  mode: 'apiKey',
  headers: { 'x-app-api-key': 'test-key' },
};

/** Write a zip holding `entries` (name → contents) to `file`. */
async function writeZip(
  file: string,
  entries: Record<string, Buffer | string>,
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) {
    zip.addBuffer(Buffer.from(data), name);
  }
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(file));
}

describe('Flutter engine detection (#1138)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-flutter-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('looks for the same entry as the API', () => {
    expect(FLUTTER_ENGINE_ENTRY).to.equal('lib/x86_64/libflutter.so');
  });

  describe('detectFlutterEngine', () => {
    it('finds the x86_64 Flutter engine', async () => {
      const apk = path.join(dir, 'flutter.apk');
      await writeZip(apk, {
        'AndroidManifest.xml': 'manifest',
        'lib/arm64-v8a/libflutter.so': 'arm',
        'lib/x86_64/libflutter.so': 'engine',
      });
      expect(await detectFlutterEngine(apk)).to.equal(true);
    });

    it('ignores an engine built only for ARM, which an x86_64 emulator cannot load', async () => {
      const apk = path.join(dir, 'arm-only.apk');
      await writeZip(apk, {
        'AndroidManifest.xml': 'manifest',
        'lib/arm64-v8a/libflutter.so': 'arm',
      });
      expect(await detectFlutterEngine(apk)).to.equal(false);
    });

    it('reports a real non-Flutter APK as not Flutter', async () => {
      expect(await detectFlutterEngine(WIKIPEDIA_APK)).to.equal(false);
    });

    it('is unknown for a file that is not a zip, or is missing', async () => {
      const notZip = path.join(dir, 'not-a-zip.apk');
      fs.writeFileSync(notZip, 'definitely not an apk');
      expect(await detectFlutterEngine(notZip)).to.equal(undefined);
      expect(await detectFlutterEngine(path.join(dir, 'missing.apk'))).to.equal(
        undefined,
      );
    });
  });

  describe('the metadata sent at finalise', () => {
    const originalFetch = globalThis.fetch;
    const originalUpload = SupabaseGateway.uploadResumable;
    const originalOverride = process.env.DCD_BINARY_KEK_PUBLIC;
    let finalised: Array<{ metadata: Record<string, unknown> }>;

    beforeEach(() => {
      const { publicKey } = generateKeyPairSync('x25519');
      const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
      process.env.DCD_BINARY_KEK_PUBLIC = `1:${raw.toString('base64')}`;

      // Storage "succeeds" without leaving the process; only the finalise
      // body is of interest.
      SupabaseGateway.uploadResumable = async () => {};
      finalised = [];
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json' },
            status,
          });
        if (url.includes('getBinaryUploadUrl')) {
          return json({ finalPath: 'final/app.apk', id: 'binary-1', tempPath: 'temp/app.apk' });
        }
        if (url.includes('finaliseUpload')) {
          finalised.push(JSON.parse(String(init?.body)));
          return json({}, 201);
        }
        return json({ message: `unexpected request to ${url}` }, 500);
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      SupabaseGateway.uploadResumable = originalUpload;
      if (originalOverride === undefined) delete process.env.DCD_BINARY_KEK_PUBLIC;
      else process.env.DCD_BINARY_KEK_PUBLIC = originalOverride;
    });

    /** A parseable APK: the wikipedia manifest, plus `extra` entries. */
    async function apkWith(extra: Record<string, string>): Promise<string> {
      const source = new StreamZip.async({ file: WIKIPEDIA_APK });
      const manifest = await source.entryData('AndroidManifest.xml');
      await source.close();
      const apk = path.join(dir, 'app.apk');
      await writeZip(apk, { 'AndroidManifest.xml': manifest, ...extra });
      return apk;
    }

    async function upload(filePath: string, encrypt: boolean) {
      await uploadBinary({
        apiUrl: API,
        auth: TEST_AUTH,
        encrypt,
        filePath,
        ignoreShaCheck: true,
        log: false,
      });
      expect(finalised).to.have.lengthOf(1);
      return finalised[0].metadata;
    }

    it('sends usesFlutterEngine: true for an encrypted Flutter APK', async () => {
      const apk = await apkWith({ [FLUTTER_ENGINE_ENTRY]: 'engine' });
      const metadata = await upload(apk, true);
      expect(metadata).to.include({ appId: 'org.wikipedia', platform: 'android', usesFlutterEngine: true });
      expect(metadata).to.have.property('enc');
    });

    it('sends usesFlutterEngine: false for an encrypted APK without the engine', async () => {
      const metadata = await upload(WIKIPEDIA_APK, true);
      expect(metadata).to.include({ usesFlutterEngine: false });
      expect(metadata).to.have.property('enc');
    });

    it('leaves the verdict to the API for a plaintext upload', async () => {
      const apk = await apkWith({ [FLUTTER_ENGINE_ENTRY]: 'engine' });
      const metadata = await upload(apk, false);
      expect(metadata).to.not.have.property('usesFlutterEngine');
      expect(metadata).to.not.have.property('enc');
    });
  });
});
