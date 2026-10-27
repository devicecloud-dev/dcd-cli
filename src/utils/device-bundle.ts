import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import { DeviceGateway } from '../gateways/device-gateway.js';
import { compressFilesFromRelativePath } from '../methods.js';
import { resolveIncludedPaths } from '../services/execution-plan.service.js';
import {
  isWorkspaceConfigFile,
  loadWorkspaceConfig,
  processDependencies,
  readTestYamlFileAsJson,
} from '../services/execution-plan.utils.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import type { DeviceFlowBundle } from '../types/domain/device-session.types.js';
import { CliError } from './cli.js';
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

const YAML_FILE = /\.ya?ml$/i;

/** Every file under `dir`, relative to it. */
function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .filter((file) => !skipped(file));
}

/**
 * The files under `dir` a bundle needs, relative to it, in a stable order:
 * every YAML file (flows, subflows, config), the files the flows use
 * (runScript, addMedia, assertScreenshot and the like), and config's
 * includedPaths. Nothing else: an agent's samples folder sent 265 MB of .apk
 * and .zip files with its flows.
 *
 * `entry` is the one flow that will run. Its files must all be inside `dir`.
 * Without an entry every flow may run, so that goes for all of them. Another
 * flow's missing file doesn't stop the entry running, so it is left out.
 */
export function bundleFiles(dir: string, entry?: string, warn: (message: string) => void = () => {}): string[] {
  const root = path.resolve(dir);
  const yamlFiles = allFiles(dir).filter((file) => YAML_FILE.test(file));
  const entryFile = entry === undefined ? undefined : path.normalize(entry);
  if (entryFile !== undefined && !yamlFiles.includes(entryFile)) {
    throw new CliError(`No flow ${entry} in ${dir}.`);
  }

  const needed = new Set(yamlFiles);
  const problems: string[] = [];
  const add = (absolute: string, strict: boolean, from: string) => {
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      if (strict) problems.push(`${from} uses ${absolute}, which is outside ${dir}. Pass a directory that holds both.`);
      return;
    }

    needed.add(relative);
  };

  for (const file of yamlFiles) {
    const absolute = path.join(root, file);
    const strict = entryFile === undefined || entryFile === file;
    if (isWorkspaceConfigFile(absolute)) continue;
    let deps: ReturnType<typeof processDependencies>;
    try {
      const { config, testSteps } = readTestYamlFileAsJson(absolute);
      deps = processDependencies({ config, input: absolute, testSteps });
    } catch (error) {
      // Not a flow (a data file, say), or one Maestro will report itself.
      if (entryFile === file) throw new CliError((error as Error).message);
      continue;
    }

    if (strict) problems.push(...deps.allErrors);
    for (const dep of deps.allFiles) {
      if (existsSync(dep)) add(dep, strict, file);
    }
  }

  for (const name of ['config.yaml', 'config.yml']) {
    if (!yamlFiles.includes(name)) continue;
    const config = loadWorkspaceConfig(path.join(root, name), warn);
    for (const file of resolveIncludedPaths(config, root, warn)) add(file, true, name);
  }

  if (problems.length > 0) throw new CliError(problems.join('\n'));
  return [...needed].sort();
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
  /** The one flow that will run, a path inside `dir`. Omitted, all of them. */
  entry?: string;
  log: (message: string) => void;
}

/**
 * Zip the files a directory's flows need (bundleFiles) and upload them as a
 * flow bundle: ask the API for
 * upload URLs, PUT the zip to both copies, then register it with its
 * SHA-256. Encrypted like `dcd cloud`'s flow zips when the org's default
 * (or DCD_ENCRYPT) says so. Entries are relative to `dir`, so a run's
 * `flow` is a path inside it, e.g. `login.yaml`.
 */
export async function uploadFlowBundle(
  opts: UploadFlowBundleOptions,
): Promise<DeviceFlowBundle & { files: number }> {
  const { apiUrl, auth, dir, entry, log } = opts;
  const files = bundleFiles(dir, entry, log);
  if (!files.some((f) => YAML_FILE.test(f))) {
    throw new CliError(`No flow files (.yaml) in ${dir}.`);
  }

  const zip = await compressFilesFromRelativePath(dir, files, '');

  let serverDefault: boolean | undefined;
  try {
    const compatibility = await fetchCompatibilityData(apiUrl, auth);
    serverDefault = compatibility.encryption?.defaultOn;
  } catch {
    serverDefault = undefined;
  }

  const encryption = await checkKekForEncryption(resolveEncryption({ serverDefault }), apiUrl);
  if (encryption.notice) log(encryption.notice);
  const kek = encryption.enabled ? await resolveKekPublicKey(apiUrl) : null;
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
