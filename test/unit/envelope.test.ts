import { expect } from 'chai';
import {
  createDecipheriv,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  encryptEnv,
  encryptFileToPath,
  encryptFlowBuffer,
  generateDek,
  resolveKekPublicKey,
  wrapDek,
} from '../../src/utils/envelope.js';

/**
 * Reference implementation of the platform *decrypt* half (as implemented in
 * dcd `api/src/common/crypto/envelope.ts` and `simulators/gateways/
 * EnvelopeGateway.ts`). If the CLI's ciphertext round-trips through this, it is
 * byte-compatible with the platform.
 */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const HKDF_INFO = Buffer.from('dcd-binary-dek-wrap-v1', 'ascii');

function refDecryptContainer(ciphertext: Buffer, dek: Buffer): Buffer {
  expect(ciphertext.subarray(0, 4).toString('ascii')).to.equal('DCDE');
  expect(ciphertext.readUInt8(4)).to.equal(1); // container version
  const chunkSize = ciphertext.readUInt32BE(6);
  const noncePrefix = ciphertext.subarray(10, 17);
  const body = ciphertext.subarray(17);
  const segBytes = chunkSize + 16;

  const out: Buffer[] = [];
  let off = 0;
  let index = 0;
  while (off < body.length) {
    const end = Math.min(off + segBytes, body.length);
    const seg = body.subarray(off, end);
    const isLast = end >= body.length;
    const ct = seg.subarray(0, seg.length - 16);
    const tag = seg.subarray(seg.length - 16);
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce, 0, 0, 7);
    nonce.writeUInt32BE(index, 7);
    nonce.writeUInt8(isLast ? 1 : 0, 11);
    const d = createDecipheriv('aes-256-gcm', dek, nonce);
    d.setAuthTag(tag);
    out.push(Buffer.concat([d.update(ct), d.final()]));
    off = end;
    index += 1;
  }
  return Buffer.concat(out);
}

function refUnwrapDek(wrappedB64: string, kekPrivRaw: Buffer): Buffer {
  const kekPriv = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, kekPrivRaw]),
    format: 'der',
    type: 'pkcs8',
  });
  const blob = Buffer.from(wrappedB64, 'base64');
  const ephPubRaw = blob.subarray(0, 32);
  const iv = blob.subarray(32, 44);
  const ct = blob.subarray(44, 76);
  const tag = blob.subarray(76, 92);
  const ephPub = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, ephPubRaw]),
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey: kekPriv, publicKey: ephPub });
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32),
  );
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function rawX25519(): { privRaw: Buffer; pubRaw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    pubRaw: publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(SPKI_PREFIX.length),
    privRaw: privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .subarray(PKCS8_PREFIX.length),
  };
}

describe('binary envelope encryption (#1138)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dcd-enc-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.DCD_BINARY_KEK_PUBLIC;
  });

  const sizes: Array<[string, number]> = [
    ['sub-chunk', 500],
    ['exactly one chunk', 1024],
    ['one chunk + 1 byte', 1025],
    ['several chunks + remainder', 4096 + 321],
  ];

  for (const [label, size] of sizes) {
    it(`encrypts ${label} payloads into a DCDE container the platform decrypt recovers`, async () => {
      const plaintext = randomBytes(size);
      const src = path.join(dir, 'plain.bin');
      const dest = path.join(dir, 'cipher.enc');
      await writeFile(src, plaintext);

      const dek = generateDek();
      await encryptFileToPath(src, dest, dek, 1, 1024); // small chunk → multi-segment

      const ciphertext = await readFile(dest);
      expect(refDecryptContainer(ciphertext, dek).equals(plaintext)).to.equal(
        true,
      );
    });
  }

  it('round-trips the wikipedia.apk fixture at the 1 MiB default chunk size', async () => {
    const apk = await readFile(
      new URL('../fixtures/wikipedia.apk', import.meta.url),
    );
    const src = path.join(dir, 'wikipedia.apk');
    const dest = path.join(dir, 'wikipedia.apk.enc');
    await writeFile(src, apk);

    const dek = generateDek();
    await encryptFileToPath(src, dest, dek, 1);

    const ciphertext = await readFile(dest);
    // Ciphertext must differ from plaintext and be recoverable byte-for-byte.
    expect(ciphertext.subarray(0, 4).toString('ascii')).to.equal('DCDE');
    expect(refDecryptContainer(ciphertext, dek).equals(apk)).to.equal(true);
  });

  it('detects tampering (GCM tag mismatch)', async () => {
    const src = path.join(dir, 'p.bin');
    const dest = path.join(dir, 'c.enc');
    await writeFile(src, randomBytes(3000));
    const dek = generateDek();
    await encryptFileToPath(src, dest, dek, 1, 1024);
    const ciphertext = await readFile(dest);
    ciphertext[25] ^= 0xff; // flip a ciphertext byte
    expect(() => refDecryptContainer(ciphertext, dek)).to.throw();
  });

  it('wraps a DEK that the matching KEK private key unwraps', () => {
    const { privRaw, pubRaw } = rawX25519();
    process.env.DCD_BINARY_KEK_PUBLIC = `3:${pubRaw.toString('base64')}`;
    const kek = resolveKekPublicKey('https://api.devicecloud.dev');
    expect(kek).to.not.equal(null);

    const dek = generateDek();
    const envelope = wrapDek(dek, kek!);
    expect(envelope.v).to.equal(1);
    expect(envelope.kek).to.equal(3);
    expect(refUnwrapDek(envelope.wrapped_key, privRaw).equals(dek)).to.equal(
      true,
    );
  });

  it('resolves the pinned KEK public key for each environment', () => {
    const prod = resolveKekPublicKey('https://api.devicecloud.dev');
    expect(prod).to.not.equal(null);
    expect(prod!.version).to.equal(1);
    expect(prod!.keyRaw.toString('base64')).to.equal(
      'wtfyWEwK7nJzwI4PD+9RAW8jxIR1u8kMQq2IhsrVnH4=',
    );

    const dev = resolveKekPublicKey('https://api.dev.devicecloud.dev');
    expect(dev).to.not.equal(null);
    expect(dev!.version).to.equal(1);
    expect(dev!.keyRaw.toString('base64')).to.equal(
      'RgcToF/OJpcQI9koYvSvtj/WLaebfcN4v5GJoqtr/00=',
    );
  });
});

describe('flow + env envelope encryption (#1151, #1152)', () => {
  afterEach(() => {
    delete process.env.DCD_BINARY_KEK_PUBLIC;
  });

  it('encryptFlowBuffer produces a container the platform decrypts to the original zip', () => {
    const { privRaw, pubRaw } = rawX25519();
    process.env.DCD_BINARY_KEK_PUBLIC = `2:${pubRaw.toString('base64')}`;
    const kek = resolveKekPublicKey('https://api.dev.devicecloud.dev')!;

    const zip = randomBytes(5000);
    const { ciphertext, enc } = encryptFlowBuffer(zip, kek);

    expect(enc.v).to.equal(1);
    expect(enc.kek).to.equal(2);
    expect(ciphertext.subarray(0, 4).toString('ascii')).to.equal('DCDE');
    const dek = refUnwrapDek(enc.wrapped_key, privRaw);
    expect(refDecryptContainer(ciphertext, dek).equals(zip)).to.equal(true);
  });

  it('encryptEnv produces an inline envelope the platform decrypts back to the map', () => {
    const { privRaw, pubRaw } = rawX25519();
    process.env.DCD_BINARY_KEK_PUBLIC = `1:${pubRaw.toString('base64')}`;
    const kek = resolveKekPublicKey('https://api.dev.devicecloud.dev')!;

    const env = { API_TOKEN: 'secret', PASSWORD: 'p@ss word=1', EMPTY: '' };
    const enc = encryptEnv(env, kek);

    expect(enc.v).to.equal(1);
    expect(enc.kek).to.equal(1);
    // API unwraps the DEK from wrapped_key; runner decrypts the inline blob.
    const dek = refUnwrapDek(enc.wrapped_key, privRaw);
    const plain = refDecryptContainer(Buffer.from(enc.ciphertext, 'base64'), dek);
    expect(JSON.parse(plain.toString('utf8'))).to.deep.equal(env);
  });

  it('gives the flow zip and env their own distinct DEKs', () => {
    const { pubRaw } = rawX25519();
    process.env.DCD_BINARY_KEK_PUBLIC = `1:${pubRaw.toString('base64')}`;
    const kek = resolveKekPublicKey('https://api.dev.devicecloud.dev')!;

    const flow = encryptFlowBuffer(randomBytes(100), kek);
    const env = encryptEnv({ A: 'b' }, kek);
    // Independent sealed boxes → the wrapped keys must differ.
    expect(flow.enc.wrapped_key).to.not.equal(env.wrapped_key);
  });
});
