import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

const DOWNLOAD_RETRY_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2000;

/**
 * Returns true if the input looks like an HTTP/HTTPS URL.
 * @param input - String to test
 * @returns True if the string begins with http:// or https://
 */
export function isUrl(input: string): boolean {
  return input.startsWith('http://') || input.startsWith('https://');
}

/**
 * Downloads a file from a URL to a temp file and returns the temp path.
 * Retries up to 3 times on network error. Expo signed URLs expire after ~1 hour,
 * so a clear error is shown on 401/403 responses.
 * Caller is responsible for deleting the returned file.
 * @param url - HTTPS URL to download from
 * @param debug - Whether to emit debug log lines
 * @returns Absolute path to the downloaded temp file
 */
export async function downloadExpoUrl(url: string, debug: boolean): Promise<string> {
  const destPath = path.join(os.tmpdir(), `dcd-expo-${randomUUID()}.tar.gz`);

  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_ATTEMPTS; attempt++) {
    if (debug) {
      console.log(`[DEBUG] Downloading Expo URL (attempt ${attempt}/${DOWNLOAD_RETRY_ATTEMPTS}): ${url}`);
    }

    try {
      const response = await fetch(url);

      if (!response.ok) {
        // 4xx responses (expired signed URL, 404, ...) won't get better on
        // retry — flag them so the catch below rethrows immediately.
        const permanent = response.status >= 400 && response.status < 500;
        let error: Error;
        if (response.status === 403 || response.status === 401) {
          error = new Error(
            `Failed to download Expo build from URL (HTTP ${response.status}). Expo signed URLs expire after ~1 hour — please generate a fresh URL with 'eas build' and try again.`,
          );
        } else {
          error = new Error(`Failed to download Expo build from URL (HTTP ${response.status}).`);
        }

        if (permanent) {
          (error as Error & { permanent?: boolean }).permanent = true;
        }

        throw error;
      }

      if (!response.body) {
        throw new Error('No response body received from Expo URL.');
      }

      // Stream to disk using pipeline to handle backpressure and avoid loading
      // the entire archive in memory
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        fs.createWriteStream(destPath),
      );

      if (debug) {
        const stat = await fsp.stat(destPath);
        console.log(`[DEBUG] Downloaded ${(stat.size / 1024 / 1024).toFixed(2)} MB to ${destPath}`);
      }

      return destPath;
    } catch (error) {
      // Clean up any partial file before retrying
      await fsp.rm(destPath, { force: true }).catch(() => {});

      const isPermanent = Boolean((error as Error & { permanent?: boolean })?.permanent);
      const isLastAttempt = attempt === DOWNLOAD_RETRY_ATTEMPTS;
      if (isPermanent || isLastAttempt) {
        throw error;
      }

      if (debug) {
        console.log(`[DEBUG] Download failed (attempt ${attempt}), retrying in ${DOWNLOAD_RETRY_DELAY_MS}ms...`);
      }

      await new Promise<void>((resolve) => { setTimeout(resolve, DOWNLOAD_RETRY_DELAY_MS); });
    }
  }

  // Unreachable — loop always throws or returns before exhausting attempts
  throw new Error('Download failed after all retry attempts.');
}

/**
 * Extracts a .tar.gz archive to a new temp directory and returns the directory path.
 * Caller is responsible for deleting the returned directory.
 * @param tarPath - Absolute path to the .tar.gz file
 * @param debug - Whether to emit debug log lines
 * @returns Absolute path to the newly created extract directory
 */
export async function extractTarGz(tarPath: string, debug: boolean): Promise<string> {
  const extractDir = path.join(os.tmpdir(), `dcd-expo-${randomUUID()}`);
  await fsp.mkdir(extractDir, { recursive: true });

  if (debug) {
    console.log(`[DEBUG] Extracting ${tarPath} to ${extractDir}`);
  }

  await tar.extract({ cwd: extractDir, file: tarPath });

  if (debug) {
    console.log(`[DEBUG] Extraction complete: ${extractDir}`);
  }

  return extractDir;
}

/**
 * Recursively searches a directory for the shallowest .app bundle and returns its absolute path.
 * Handles both root-level bundles (MyApp.app/) and nested layouts (Payload/MyApp.app/).
 * @param dir - Directory to search within
 * @returns Absolute path to the .app directory
 */
export async function findAppBundle(dir: string): Promise<string> {
  const candidates: Array<{ depth: number; fullPath: string }> = [];

  async function walk(current: string, depth: number): Promise<void> {
    const entries = await fsp.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app')) {
          candidates.push({ depth, fullPath });
          // Do not recurse into the .app bundle itself
        } else if (entry.name !== '__MACOSX') {
          // Skip __MACOSX metadata directories created by macOS zip utilities
          await walk(fullPath, depth + 1);
        }
      }
    }
  }

  await walk(dir, 0);

  if (candidates.length === 0) {
    throw new Error(
      'No .app bundle found inside the archive. Ensure you are using an iOS Expo build (eas build --platform ios).',
    );
  }

  // Return the shallowest (lowest depth) candidate
  candidates.sort((a, b) => a.depth - b.depth);
  return candidates[0].fullPath;
}
