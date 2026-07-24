import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { inferEnvFromApiUrl } from '../config/environments.js';
import { ENVIRONMENTS } from '../config/environments.js';

/**
 * Client-side envelope encryption of app binaries before upload (dcd#1138).
 *
 * The CLI is the *encrypt* half of the contract; the platform (api +
 * simulators, in the `dcd` repo) is the *decrypt* half. This module MUST stay
 * byte-compatible with `api/src/common/crypto/envelope.ts` — the wire format is
 * specified in `dcd/docs/binary-envelope-encryption.md`.
 *
 * Scheme: a per-upload random 256-bit DEK encrypts the binary (chunked
 * AES-256-GCM); the DEK is wrapped with the environment's pinned X25519 KEK
 * public key (sealed box). Only the platform API holds the KEK private half, so
 * every storage/transport tier sees ciphertext only.
 */

const MAGIC = Buffer.from('DCDE', 'ascii');
const CONTAINER_VERSION = 1;
const NONCE_LEN = 12;
const NONCE_PREFIX_LEN = 7;
const DEK_LEN = 32;
export const CHUNK_SIZE = 1024 * 1024; // 1 MiB plaintext segments

const HKDF_INFO = Buffer.from('dcd-binary-dek-wrap-v1', 'ascii');
// DER prefix that turns a raw 32-byte X25519 public key into an importable SPKI.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** `binaries.metadata.enc` shape written for an encrypted upload. */
export interface BinaryEnvelope {
  v: number;
  kek: number;
  wrapped_key: string;
}

/** Pinned KEK public key (base64 raw 32-byte X25519) + version, per env. */
interface KekPublicKey {
  version: number;
  keyRaw: Buffer;
}

function x25519PublicFromRaw(raw: Buffer) {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Resolve the KEK public key for the environment behind `apiUrl`. Order:
 *   1. `DCD_BINARY_KEK_PUBLIC` env override (`<version>:<base64>`, e.g. `1:AAAA…`)
 *      — lets the feature be exercised before keys are pinned in the release.
 *   2. the pinned `ENVIRONMENTS[env].kekPublicKey`.
 * Returns null when no key is available (encryption cannot proceed).
 */
export function resolveKekPublicKey(apiUrl: string): KekPublicKey | null {
  const override = process.env.DCD_BINARY_KEK_PUBLIC;
  if (override) {
    const [versionPart, b64] = override.split(':');
    const version = Number(versionPart);
    if (b64 && Number.isInteger(version)) {
      const keyRaw = Buffer.from(b64, 'base64');
      if (keyRaw.length === 32) return { version, keyRaw };
    }
    throw new Error(
      'DCD_BINARY_KEK_PUBLIC must be "<version>:<base64 32-byte X25519 public key>"',
    );
  }

  const env = inferEnvFromApiUrl(apiUrl);
  const pinned = ENVIRONMENTS[env].kekPublicKey;
  if (!pinned) return null;
  const keyRaw = Buffer.from(pinned.key, 'base64');
  if (keyRaw.length !== 32) {
    throw new Error(`Pinned KEK public key for ${env} is not a 32-byte key`);
  }
  return { version: pinned.version, keyRaw };
}

/**
 * Wrap a DEK for the given KEK public key (X25519 sealed box). Produces base64 of
 * `ephPub(32) || iv(12) || ciphertext(32) || tag(16)`.
 */
export function wrapDek(dek: Buffer, kek: KekPublicKey): BinaryEnvelope {
  const eph = generateKeyPairSync('x25519');
  const ephPubRaw = eph.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(SPKI_PREFIX.length);
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: x25519PublicFromRaw(kek.keyRaw),
  });
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32),
  );
  const iv = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const wrapped = Buffer.concat([
    ephPubRaw,
    iv,
    ct,
    cipher.getAuthTag(),
  ]).toString('base64');
  return { v: CONTAINER_VERSION, kek: kek.version, wrapped_key: wrapped };
}

function segmentNonce(
  prefix: Buffer,
  index: number,
  isLast: boolean,
): Buffer {
  const nonce = Buffer.alloc(NONCE_LEN);
  prefix.copy(nonce, 0, 0, NONCE_PREFIX_LEN);
  nonce.writeUInt32BE(index, NONCE_PREFIX_LEN);
  nonce.writeUInt8(isLast ? 1 : 0, NONCE_PREFIX_LEN + 4);
  return nonce;
}

/**
 * Stream-encrypt `srcPath` into a DCDE container at `destPath` using `dek`, in
 * constant memory (one chunk buffered at a time). `kekVersion` is written into
 * the header (mirrors the wrapped-key's KEK version).
 */
export async function encryptFileToPath(
  srcPath: string,
  destPath: string,
  dek: Buffer,
  kekVersion: number,
  chunkSize: number = CHUNK_SIZE,
): Promise<void> {
  if (dek.length !== DEK_LEN) {
    throw new Error(`DEK must be ${DEK_LEN} bytes`);
  }
  const { size } = await stat(srcPath);
  const noncePrefix = randomBytes(NONCE_PREFIX_LEN);

  const header = Buffer.alloc(17);
  MAGIC.copy(header, 0);
  header.writeUInt8(CONTAINER_VERSION, 4);
  header.writeUInt8(kekVersion, 5);
  header.writeUInt32BE(chunkSize, 6);
  noncePrefix.copy(header, 10);

  const input = await open(srcPath, 'r');
  const output = await open(destPath, 'w');
  try {
    await output.write(header);
    const buf = Buffer.alloc(chunkSize);
    let index = 0;
    let readTotal = 0;
    // size 0 → no segments (matches the API's empty-input handling).
    while (readTotal < size) {
      const { bytesRead } = await input.read(buf, 0, chunkSize, null);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
      const isLast = readTotal >= size;
      const cipher = createCipheriv(
        'aes-256-gcm',
        dek,
        segmentNonce(noncePrefix, index, isLast),
      );
      const ct = Buffer.concat([
        cipher.update(buf.subarray(0, bytesRead)),
        cipher.final(),
      ]);
      await output.write(ct);
      await output.write(cipher.getAuthTag());
      index += 1;
      if (isLast) break;
    }
  } finally {
    await input.close();
    await output.close();
  }
}

/** Generate a fresh per-upload DEK. */
export function generateDek(): Buffer {
  return randomBytes(DEK_LEN);
}
