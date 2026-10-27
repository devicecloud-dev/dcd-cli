import { expect } from 'chai';
import { createHash, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import StreamZip from 'node-stream-zip';

import { clearCompatibilityCache } from '../../src/utils/compatibility.js';
import { bundleFiles, uploadFlowBundle } from '../../src/utils/device-bundle.js';

const API = 'https://api.devicecloud.dev';
const auth = { headers: {}, mode: 'apiKey' as const };

interface Call {
  body?: Uint8Array | string;
  method: string;
  url: string;
}

describe('dcd device run <dir>: flow bundles', () => {
  const realFetch = globalThis.fetch;
  const ORIGINAL_ENV = { ...process.env };
  let dir: string;
  let calls: Call[];
  let encryptionDefault: boolean;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-bundle-test-'));
    fs.mkdirSync(path.join(dir, 'flows'));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'flows', 'login.yaml'), 'appId: x\n---\n- launchApp\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'flows: [flows/*]\n');
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '');
    delete process.env.DCD_ENCRYPT;
    delete process.env.DCD_ENCRYPT_BINARIES;
    encryptionDefault = false;
    clearCompatibilityCache();
    calls = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        body: init?.body as Uint8Array | string | undefined,
      };
      calls.push(call);
      if (url.includes('/results/compatibility')) {
        return new Response(
          JSON.stringify({ statusCode: 200, data: { encryption: { defaultOn: encryptionDefault } } }),
        );
      }

      if (url.endsWith('/device/bundles/upload-url')) {
        return new Response(
          JSON.stringify({
            id: 'b-1',
            upload: { path: 'p', signedUrl: 'https://sb/put' },
            mirror: { path: 'organizations/p', signedUrl: 'https://b2/put' },
          }),
        );
      }

      if (url === 'https://sb/put') return new Response(null, { status: 200 });
      if (url === 'https://b2/put') return new Response(null, { status: 500 });
      if (url.endsWith('/device/bundles')) {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ bundle: { ...body, encrypted: Boolean(body.enc), created_at: 'now' } }),
        );
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    clearCompatibilityCache();
    globalThis.fetch = realFetch;
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('bundles the YAML files, leaving out dot-folders and node_modules', () => {
    expect(bundleFiles(dir)).to.deep.equal(['config.yaml', path.join('flows', 'login.yaml')]);
  });

  describe('which files go in', () => {
    const write = (file: string, text = '') => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    };

    beforeEach(() => {
      write(
        'flows/checkout.yaml',
        'appId: x\n---\n- runFlow: ../subflows/pay.yaml\n- runScript: ../scripts/seed.js\n',
      );
      write('subflows/pay.yaml', 'appId: x\n---\n- addMedia:\n    - ../media/card.png\n');
      write('scripts/seed.js', 'output.ok = true');
      write('media/card.png', 'png');
      write('media/unused.png', 'png');
      write('builds/app.apk', 'apk');
      write('builds/app.zip', 'zip');
    });

    it("takes the flows' scripts and media, but not builds or files no flow uses", () => {
      expect(bundleFiles(dir)).to.deep.equal(
        [
          'config.yaml',
          'flows/checkout.yaml',
          'flows/login.yaml',
          'media/card.png',
          'scripts/seed.js',
          'subflows/pay.yaml',
        ].map((f) => path.normalize(f)),
      );
    });

    it("adds config's includedPaths", () => {
      write('config.yaml', 'flows: [flows/*]\nincludedPaths: [media/unused.png]\n');
      expect(bundleFiles(dir)).to.include(path.normalize('media/unused.png'));
    });

    it("refuses an entry whose file is missing, naming it", () => {
      fs.rmSync(path.join(dir, 'scripts', 'seed.js'));
      expect(() => bundleFiles(dir, 'flows/checkout.yaml')).to.throw(/seed\.js/);
    });

    it("runs an entry even when another flow's file is missing", () => {
      write('flows/broken.yaml', 'appId: x\n---\n- runScript: ../scripts/gone.js\n');
      expect(bundleFiles(dir, 'flows/login.yaml')).to.include(path.normalize('flows/login.yaml'));
      // Without an entry every flow may run, so the missing file matters.
      expect(() => bundleFiles(dir)).to.throw(/gone\.js/);
    });

    it('refuses an entry that is not in the directory', () => {
      expect(() => bundleFiles(dir, 'flows/nope.yaml')).to.throw('No flow flows/nope.yaml');
    });

    it('refuses a flow that uses a file outside the directory', () => {
      const outside = path.join(path.dirname(dir), `${path.basename(dir)}-shared.js`);
      fs.writeFileSync(outside, '');
      try {
        write('flows/out.yaml', `appId: x\n---\n- runScript: ../../${path.basename(outside)}\n`);
        expect(() => bundleFiles(dir)).to.throw(/outside/);
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });
  });

  it('uploads the zip to both copies and registers what landed', async () => {
    const bundle = await uploadFlowBundle({ apiUrl: API, auth, dir, log: () => {} });
    expect(bundle.id).to.equal('b-1');
    expect(bundle.files).to.equal(2);

    const put = calls.find((c) => c.url === 'https://sb/put')!;
    expect(put.method).to.equal('PUT');
    const zipBytes = Buffer.from(put.body as Uint8Array);

    const register = calls.find((c) => c.url.endsWith('/device/bundles'))!;
    const sent = JSON.parse(String(register.body));
    expect(sent).to.deep.equal({
      id: 'b-1',
      sha: createHash('sha256').update(zipBytes).digest('hex'),
      bytes: zipBytes.length,
      supabase: true,
      // The B2 PUT failed, so only the Supabase copy is claimed.
      backblaze: false,
    });

    // Entries are relative to the directory, so `--entry flows/login.yaml` matches.
    const zipPath = path.join(dir, 'out.zip');
    fs.writeFileSync(zipPath, zipBytes);
    const zip = new StreamZip.async({ file: zipPath });
    expect(Object.keys(await zip.entries()).sort()).to.deep.equal(['config.yaml', 'flows/login.yaml']);
    await zip.close();
  });

  it("encrypts the zip when the org's default says so", async () => {
    const { publicKey } = generateKeyPairSync('x25519');
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
    process.env.DCD_BINARY_KEK_PUBLIC = `1:${raw.toString('base64')}`;
    encryptionDefault = true;

    const bundle = await uploadFlowBundle({ apiUrl: API, auth, dir, log: () => {} });
    expect(bundle.encrypted).to.equal(true);
    const put = calls.find((c) => c.url === 'https://sb/put')!;
    expect(Buffer.from(put.body as Uint8Array).subarray(0, 4).toString()).to.equal('DCDE');
    const sent = JSON.parse(String(calls.find((c) => c.url.endsWith('/device/bundles'))!.body));
    expect(sent.enc).to.include.keys('v', 'kek', 'wrapped_key');
  });

  it('refuses a directory with no flows', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-bundle-empty-'));
    fs.writeFileSync(path.join(empty, 'notes.txt'), '');
    try {
      await uploadFlowBundle({ apiUrl: API, auth, dir: empty, log: () => {} });
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as Error).message).to.include('No flow files');
    } finally {
      fs.rmSync(empty, { force: true, recursive: true });
    }
  });
});
