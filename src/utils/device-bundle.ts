import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

import { DeviceGateway } from '../gateways/device-gateway.js';
import { compressFilesFromRelativePath } from '../methods.js';
import { resolveIncludedPaths } from '../services/execution-plan.service.js';
import { computeCommonRoot } from '../services/flow-paths.js';
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

/**
 * Never walked for flows: dependencies, version control and other tools'
 * dot-folders and dot-files. `.maestro`, where Maestro keeps flows by
 * convention, is walked.
 */
function skipped(name: string): boolean {
  return name === 'node_modules' || (name.startsWith('.') && name !== '.maestro');
}

const YAML_FILE = /\.ya?ml$/i;

/** Every file under `dir`, relative to it, without going into the folders `skipped` names. */
function allFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      if (skipped(entry.name)) continue;
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };

  walk('');
  return files;
}

/**
 * The files a flow reaches: the flow, the files it uses (runFlow, runScript,
 * addMedia, assertScreenshot and the like), and the files those use in turn.
 * Absolute paths, the flow first. `problems` are the files it names that do
 * not exist. A flow that can't be read throws; a YAML file it uses that is
 * not a flow (a data file) is taken as it is.
 */
export function reachableFiles(flow: string): { files: string[]; problems: string[] } {
  const first = path.resolve(flow);
  const files: string[] = [];
  const problems: string[] = [];
  const queue = [first];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    if (!YAML_FILE.test(file) || (file !== first && isWorkspaceConfigFile(file))) continue;
    let deps: ReturnType<typeof processDependencies>;
    try {
      const { config, testSteps } = readTestYamlFileAsJson(file);
      deps = processDependencies({ config, input: file, testSteps });
    } catch (error) {
      if (file === first) throw new CliError((error as Error).message);
      continue;
    }

    problems.push(...deps.allErrors);
    for (const dep of deps.allFiles) {
      if (existsSync(dep)) queue.push(path.normalize(dep));
    }
  }

  return { files, problems };
}

/**
 * For a single flow file that uses other files (runFlow, runScript, addMedia
 * and the like): the folder to upload as a bundle, and the file's path
 * inside it. Sent as yaml on its own, the flow would fail on the device with
 * an invalid file path, because the files it uses would not be there. The
 * folder is the closest one that holds every file the flow reaches; only
 * those files are uploaded. Null when the flow uses no other files, or can't
 * be read (the device reports that itself).
 */
export function flowFileBundle(file: string): { dir: string; entry: string } | null {
  const absolute = path.resolve(file);
  let reached: ReturnType<typeof reachableFiles>;
  try {
    reached = reachableFiles(absolute);
  } catch {
    return null;
  }

  // A missing file goes this way too, so the upload names it.
  if (reached.files.length === 1 && reached.problems.length === 0) return null;
  const dir = computeCommonRoot([absolute], reached.files.slice(1)) || path.dirname(absolute);
  return { dir, entry: path.relative(dir, absolute) };
}

/** A path inside a bundle as the API takes it: forward slashes on every platform. */
export function bundlePath(relative: string): string {
  return relative.split(path.sep).join('/');
}

/**
 * The files under `dir` a bundle needs, relative to it, in a stable order.
 *
 * With an `entry`, the one flow that will run: that flow and the files it
 * reaches (reachableFiles), which must all be inside `dir`. Nothing else is
 * read or sent, so a folder high above the flow (a home directory, say)
 * costs nothing and gives nothing away.
 *
 * Without one, every flow may run: every YAML file (flows, subflows, config)
 * and the files they use. Either way, config's includedPaths too, and nothing
 * else: an agent's samples folder sent 265 MB of .apk and .zip files with
 * its flows.
 */
export function bundleFiles(
  dir: string,
  entry?: string,
  warn: (message: string) => void = () => {},
  confineTo?: string,
): string[] {
  const root = path.resolve(dir);
  const configs = ['config.yaml', 'config.yml'].filter((name) => existsSync(path.join(root, name)));
  const needed = new Set<string>();
  const problems: string[] = [];
  const add = (absolute: string, strict: boolean, from: string) => {
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      if (strict) problems.push(`${from} uses ${absolute}, which is outside ${dir}. Pass a directory that holds both.`);
      return;
    }

    needed.add(relative);
  };

  if (entry === undefined) {
    const yamlFiles = allFiles(dir).filter((file) => YAML_FILE.test(file));
    for (const file of yamlFiles) needed.add(file);
    for (const file of yamlFiles) {
      const absolute = path.join(root, file);
      if (isWorkspaceConfigFile(absolute)) continue;
      let deps: ReturnType<typeof processDependencies>;
      try {
        const { config, testSteps } = readTestYamlFileAsJson(absolute);
        deps = processDependencies({ config, input: absolute, testSteps });
      } catch {
        // Not a flow (a data file, say), or one Maestro will report itself.
        continue;
      }

      problems.push(...deps.allErrors);
      for (const dep of deps.allFiles) {
        if (existsSync(dep)) add(dep, true, file);
      }
    }
  } else {
    const entryFile = path.resolve(root, path.normalize(entry));
    const inside = path.relative(root, entryFile);
    if (inside.startsWith('..') || path.isAbsolute(inside) || !YAML_FILE.test(entryFile) || !existsSync(entryFile)) {
      throw new CliError(`No flow ${entry} in ${dir}.`);
    }

    const reached = reachableFiles(entryFile);
    problems.push(...reached.problems);
    for (const file of reached.files) add(file, true, entry);
    for (const name of configs) needed.add(name);
  }

  for (const name of configs) {
    const config = loadWorkspaceConfig(path.join(root, name), warn);
    for (const file of resolveIncludedPaths(config, root, warn)) add(file, true, name);
  }

  // For an agent's call (the dcd mcp bridge): a file that is a link to one
  // outside the folder it may read would send that file's contents.
  if (confineTo !== undefined) {
    const allowed = realpathSync(confineTo);
    for (const file of needed) {
      const real = realpathSync(path.join(root, file));
      const relative = path.relative(allowed, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        problems.push(`${file} is a link to a file outside ${confineTo}, which is not sent.`);
      }
    }
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
  /** Send nothing that resolves outside this folder (links included). */
  confineTo?: string;
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
  const { apiUrl, auth, confineTo, dir, entry, log } = opts;
  const files = bundleFiles(dir, entry, log, confineTo);
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
