import { rm } from 'node:fs/promises';

import { uploadBinary, verifyAppZip } from '../methods.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import { CliError } from './cli.js';
import { fetchCompatibilityData } from './compatibility.js';
import { checkKekForEncryption, resolveEncryption } from './envelope.js';
import { extractTarGz, findAppBundle } from './expo.js';

const APP_EXTENSIONS = ['.apk', '.app', '.zip', '.tar.gz'] as const;

/** The platform a local build is for, from its file name; undefined if unknown. */
export function platformOfAppFile(filePath: string): 'android' | 'ios' | undefined {
  const clean = filePath.replace(/\/+$/, '');
  if (clean.endsWith('.apk')) return 'android';
  if (['.app', '.zip', '.tar.gz'].some((ext) => clean.endsWith(ext))) return 'ios';
  return undefined;
}

export interface UploadLocalAppOptions {
  apiUrl: string;
  auth: AuthContext;
  filePath: string;
  /** Show the upload's progress spinner. Only on a TTY, never under --json. */
  showProgress: boolean;
  /** One line of progress for a person, e.g. the encryption notice. */
  log: (message: string) => void;
}

/**
 * Upload a local build the way `dcd upload` does, and return its binary id:
 * an Expo `.tar.gz` is unpacked to its `.app`, a `.zip` is checked, and the
 * org's encryption default applies. URLs are not handled here: `dcd device`
 * hands those to the API's install-from-URL instead.
 */
export async function uploadLocalApp(opts: UploadLocalAppOptions): Promise<string> {
  const { apiUrl, auth, log } = opts;
  let filePath = opts.filePath.replace(/\/+$/, '');
  if (!APP_EXTENSIONS.some((ext) => filePath.endsWith(ext))) {
    throw new CliError(
      'The app must be a .apk for Android, or a .app, .zip or .tar.gz (Expo) for iOS.',
    );
  }

  // As in `dcd upload`: a failed compatibility fetch leaves the default off
  // rather than failing the upload.
  let serverDefault: boolean | undefined;
  try {
    const compatibility = await fetchCompatibilityData(apiUrl, auth);
    serverDefault = compatibility.encryption?.defaultOn;
  } catch {
    serverDefault = undefined;
  }

  const encryption = await checkKekForEncryption(resolveEncryption({ serverDefault }), apiUrl);
  if (encryption.notice) log(encryption.notice);

  const tempDirs: string[] = [];
  try {
    if (filePath.endsWith('.tar.gz')) {
      const dir = await extractTarGz(filePath, false);
      tempDirs.push(dir);
      filePath = await findAppBundle(dir);
    }

    if (filePath.endsWith('.zip')) await verifyAppZip(filePath);

    return await uploadBinary({
      apiUrl,
      auth,
      encrypt: encryption.enabled,
      filePath,
      log: opts.showProgress,
    });
  } finally {
    for (const dir of tempDirs) await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
}
