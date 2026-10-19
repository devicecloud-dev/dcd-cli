import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import * as path from 'node:path';

import { DeviceGateway } from '../gateways/device-gateway.js';
import { compressFilesFromRelativePath } from '../methods.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import type { DeviceFlowBundle } from '../types/domain/device-session.types.js';
import { detectCiContext } from './ci.js';
import { CliError, getCliVersion } from './cli.js';
import { fetchCompatibilityData } from './compatibility.js';
import {
  checkKekForEncryption,
  encryptFlowBuffer,
  resolveEncryption,
  resolveKekPublicKey,
} from './envelope.js';

/** The API's limit on a bundle (dcd plan 2.5b). */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

/** Never bundled: version control, dependencies, and other dot-folders. */
function skipped(relativePath: string): boolean {
  return relativePath
    .split(path.sep)
    .some((part) => part === 'node_modules' || (part.startsWith('.') && part !== '.'));
}

/** Every file under `dir`, relative to it, in a stable order. */
export function bundleFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .filter((file) => !skipped(file))
    .sort();
}

/** PUT the zip to one signed URL. The URL is the credential. */
async function put(url: string, body: Buffer): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/zip' },
        body: new Uint8Array(body),
      });
      await res.body?.cancel();
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return false;
      }
    } catch {
      // A network error: try once more.
    }
  }

  return false;
}

export interface UploadFlowBundleOptions {
  apiUrl: string;
  auth: AuthContext;
  dir: string;
  log: (message: string) => void;
}

/**
 * Zip a directory of flows and upload it as a flow bundle: ask the API for
 * upload URLs, PUT the zip to both copies, then register it with its
 * SHA-256. Encrypted like `dcd cloud`'s flow zips when the org's default
 * (or DCD_ENCRYPT) says so. Entries are relative to `dir`, so a run's
 * `flow` is a path inside it, e.g. `login.yaml`.
 */
export async function uploadFlowBundle(
  opts: UploadFlowBundleOptions,
): Promise<DeviceFlowBundle & { files: number }> {
  const { apiUrl, auth, dir, log } = opts;
  const files = bundleFiles(dir);
  if (!files.some((f) => /\.ya?ml$/i.test(f))) {
    throw new CliError(`No flow files (.yaml) in ${dir}.`);
  }

  const zip = await compressFilesFromRelativePath(dir, files, '');

  let serverDefault: boolean | undefined;
  try {
    const ci = detectCiContext();
    const compatibility = await fetchCompatibilityData(apiUrl, auth, {
      cliVersion: getCliVersion(),
      ciProvider: ci.provider,
      ciWrapperVersion: ci.wrapperVersion,
    });
    serverDefault = compatibility.encryption?.defaultOn;
  } catch {
    serverDefault = undefined;
  }

  const encryption = checkKekForEncryption(resolveEncryption({ serverDefault }), apiUrl);
  if (encryption.notice) log(encryption.notice);
  const kek = encryption.enabled ? resolveKekPublicKey(apiUrl) : null;
  const sealed = kek ? encryptFlowBuffer(zip, kek) : null;
  const body = sealed ? sealed.ciphertext : zip;

  if (body.length > MAX_BUNDLE_BYTES) {
    throw new CliError(
      `${dir} zips to ${(body.length / 1024 / 1024).toFixed(1)} MB; a bundle can be at most ${MAX_BUNDLE_BYTES / 1024 / 1024} MB.`,
    );
  }

  const sha = createHash('sha256').update(body).digest('hex');
  const urls = await DeviceGateway.bundleUploadUrls(apiUrl, auth, body.length);
  const [supabase, backblaze] = await Promise.all([
    urls.upload ? put(urls.upload.signedUrl, body) : Promise.resolve(false),
    urls.mirror ? put(urls.mirror.signedUrl, body) : Promise.resolve(false),
  ]);
  if (!supabase && !backblaze) {
    throw new Error('The flow bundle could not be uploaded. Please retry.');
  }

  const { bundle } = await DeviceGateway.registerBundle(apiUrl, auth, {
    id: urls.id,
    sha,
    bytes: body.length,
    supabase,
    backblaze,
    ...(sealed && { enc: sealed.enc }),
  });
  return { ...bundle, files: files.length };
}
