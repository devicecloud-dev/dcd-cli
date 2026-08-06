import { ux } from './utils/progress.js';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import StreamZip from 'node-stream-zip';
import * as yazl from 'yazl';

import { inferEnvFromApiUrl } from './config/environments.js';
import { ApiError, ApiGateway } from './gateways/api-gateway.js';
import { SupabaseGateway } from './gateways/supabase-gateway.js';
import { MetadataExtractorService } from './services/metadata-extractor.service.js';
import { TAppMetadata } from './types.js';
import type { AuthContext } from './types/domain/auth.types.js';
import {
  type BinaryEnvelope,
  encryptFileToPath,
  generateDek,
  isEncryptionEnabled,
  resolveKekPublicKey,
  wrapDek,
} from './utils/envelope.js';
import { colors, formatId } from './utils/styling.js';

const mimeTypeLookupByExtension: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
  yaml: 'application/x-yaml',
  zip: 'application/zip',
};

async function zipToBuffer(zipfile: yazl.ZipFile): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Typed as Uint8Array[] so Buffer.concat infers Buffer<ArrayBuffer> — matches
    // the `BlobPart` shape that callers pass to `new Blob([...])`.
    const chunks: Uint8Array[] = [];
    zipfile.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.outputStream.on('error', reject);
    zipfile.end();
  });
}

/** Normalize a filesystem path to a POSIX-style zip entry name. */
function toZipEntryName(relativePath: string): string {
  return relativePath.split(path.sep).join('/').replace(/^\/+/, '');
}

/**
 * Zip a .app directory to a temp file on disk, streaming entries through
 * yazl so the archive is never held in memory (iOS bundles run to GBs).
 * Returns the temp directory holding the zip — callers remove it after the
 * upload completes.
 */
async function compressFolderToTempZip(
  sourceDir: string,
): Promise<{ tempDir: string; zipPath: string }> {
  const zipfile = new yazl.ZipFile();
  const rootName = path.basename(sourceDir);

  const entries = readdirSync(sourceDir, {
    recursive: true,
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = path.join(entry.parentPath, entry.name);
    const relativePath = path.relative(sourceDir, absolutePath);
    zipfile.addFile(absolutePath, toZipEntryName(path.join(rootName, relativePath)));
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dcd-app-zip-'));
  const zipPath = path.join(tempDir, `${rootName}.zip`);
  zipfile.end();
  await pipeline(zipfile.outputStream, createWriteStream(zipPath));
  return { tempDir, zipPath };
}

export const compressFilesFromRelativePath = async (
  basePath: string,
  files: string[],
  commonRoot: string,
): Promise<Buffer> => {
  const zipfile = new yazl.ZipFile();
  for (const file of files) {
    // Anchored prefix strip — replace() would remove the first occurrence
    // of commonRoot anywhere in the path, not just at the start.
    zipfile.addFile(
      path.resolve(basePath, file),
      toZipEntryName(file.startsWith(commonRoot) ? file.slice(commonRoot.length) : file),
    );
  }
  return zipToBuffer(zipfile);
};

export const verifyAppZip = async (zipPath: string) => {
  // eslint-disable-next-line new-cap
  const zip = await new StreamZip.async({
    file: zipPath,
    storeEntries: true,
  });
  try {
    const entries = await zip.entries();
    // Derive top-level names from all entries rather than requiring an
    // explicit directory entry — zips created without directory entries
    // (e.g. Python's zipfile) are valid but have no ".app/" entry itself.
    // macOS metadata (__MACOSX resource forks, .DS_Store) doesn't count
    // toward the "exactly one .app" rule.
    const topLevelNames = new Set(
      Object.values(entries)
        .filter(
          (entry) =>
            !entry.name.startsWith('__MACOSX/') &&
            entry.name.split('/').pop() !== '.DS_Store',
        )
        .map((entry) => entry.name.split('/')[0]),
    );
    if (topLevelNames.size !== 1 || ![...topLevelNames][0].endsWith('.app')) {
      throw new Error(
        'Zip file must contain exactly one entry which is a .app, check the contents of the zip file',
      );
    }
  } finally {
    zip.close();
  }
};

interface UploadBinaryConfig {
  auth: AuthContext;
  apiUrl: string;
  debug?: boolean;
  /**
   * Encrypt the binary before upload (client-side envelope encryption, #1138).
   * Defaults to `DCD_ENCRYPT` / `DCD_ENCRYPT_BINARIES` when unset (see
   * {@link isEncryptionEnabled}).
   */
  encrypt?: boolean;
  filePath: string;
  ignoreShaCheck?: boolean;
  log?: boolean;
}

export const uploadBinary = async (config: UploadBinaryConfig) => {
  const { filePath, apiUrl, auth, ignoreShaCheck = false, log = true, debug = false } = config;
  const encrypt = isEncryptionEnabled(config.encrypt);
  if (log) {
    ux.action.start(colors.bold('Checking and uploading binary'), colors.dim('Initializing'), {
      stdout: true,
    });
  }

  if (debug) {
    console.log('[DEBUG] Binary upload started');
    console.log(`[DEBUG] File path: ${filePath}`);
    console.log(`[DEBUG] API URL: ${apiUrl}`);
    console.log(`[DEBUG] Ignore SHA check: ${ignoreShaCheck}`);
  }

  const startTime = Date.now();
  let source: UploadSource | undefined;
  let encCleanupDir: string | undefined;
  let enc: BinaryEnvelope | undefined;

  try {
    // Prepare file for upload
    source = await prepareFileForUpload(filePath, debug, startTime);

    // Hash the PLAINTEXT first, before any encryption (dcd#1168). Encryption
    // uses a fresh random DEK per upload, so the ciphertext hash differs every
    // time and cannot dedup — the plaintext hash is the only stable key. Doing it
    // in this order also means a dedup hit skips the encryption work entirely,
    // not just the upload.
    const shaPlain = await calculateFileHash(source, debug, log);

    // Check for an existing upload before spending anything on encryption.
    if (!ignoreShaCheck && shaPlain) {
      const { exists, binaryId } = await checkExistingUpload(
        apiUrl,
        auth,
        encrypt ? { encrypted: true, shaPlain } : { sha: shaPlain },
        debug,
      );

      if (exists && binaryId) {
        if (log) {
          ux.info(
            colors.dim('SHA hash matches existing binary with ID: ') + formatId(binaryId) + colors.dim(', skipping upload. Force upload with --ignore-sha-check'),
          );
          ux.action.stop(colors.info('Skipping upload'));
        }

        return binaryId;
      }
    }

    // Encrypt after the dedup check, so the SHA sent at finalise, and both
    // uploaders, operate on ciphertext (binaries.sha = ciphertext hash, #1138).
    if (encrypt) {
      const encrypted = await encryptUploadSource(source, apiUrl, debug);
      enc = encrypted.enc;
      encCleanupDir = encrypted.cleanupDir;
      if (log) {
        ux.info(colors.dim(`Encrypting binary before upload (KEK v${enc.kek})`));
      }
    }

    // Re-hash once encrypted: what lands in storage is the ciphertext, and every
    // downstream verifySha hashes the bytes it actually holds (no DEK required).
    const sha = encrypt ? await calculateFileHash(source, debug, false) : shaPlain;

    // Perform the upload
    const uploadId = await performUpload({
      auth,
      apiUrl,
      debug,
      enc,
      filePath,
      sha,
      // Only encrypted uploads record a plaintext hash; it is what makes the
      // next encrypted run of this binary dedupable.
      shaPlain: encrypt ? shaPlain : undefined,
      source,
      startTime,
    });

    if (log) {
      ux.action.stop(colors.success('\n✓ Binary uploaded with ID: ') + formatId(uploadId));
    }

    return uploadId;
  } catch (error) {
    if (log) {
      ux.action.stop(colors.error('✗ Failed'));
    }

    if (debug) {
      console.error('[DEBUG] === BINARY UPLOAD FAILED ===');
      console.error('[DEBUG] Binary upload failed:', error);
      console.error(`[DEBUG] Error type: ${error instanceof Error ? error.name : typeof error}`);
      console.error(`[DEBUG] Error message: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        console.error(`[DEBUG] Stack trace: ${error.stack}`);
      }

      console.error(`[DEBUG] Failed after ${Date.now() - startTime}ms`);
    }

    throw error;
  } finally {
    if (source?.cleanupDir) {
      await rm(source.cleanupDir, { recursive: true, force: true }).catch(() => {});
    }
    if (encCleanupDir) {
      await rm(encCleanupDir, { recursive: true, force: true }).catch(() => {});
    }
  }
};

/**
 * Encrypt the prepared upload source in place (dcd#1138): generate a per-upload
 * DEK, stream-encrypt `source.diskPath` into a temp ciphertext file, wrap the
 * DEK with the environment's pinned KEK public key, and repoint `source` at the
 * ciphertext so the SHA, dedup check, and both uploaders operate on ciphertext.
 * Returns the envelope metadata (for `binaries.metadata.enc`) plus the temp dir
 * to clean up. Throws if no KEK is available for the environment.
 */
async function encryptUploadSource(
  source: UploadSource,
  apiUrl: string,
  debug: boolean,
): Promise<{ enc: BinaryEnvelope; cleanupDir: string }> {
  const kek = resolveKekPublicKey(apiUrl);
  if (!kek) {
    throw new Error(
      'Binary encryption was requested but no KEK public key is configured for this environment. ' +
        'Set DCD_BINARY_KEK_PUBLIC=<version>:<base64> or pin one in src/config/environments.ts.',
    );
  }

  const dek = generateDek();
  const enc = wrapDek(dek, kek);
  const cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'dcd-enc-'));
  const cipherPath = path.join(cleanupDir, 'binary.enc');

  if (debug) {
    console.log(`[DEBUG] Encrypting binary with KEK v${kek.version} -> ${cipherPath}`);
  }

  await encryptFileToPath(source.diskPath, cipherPath, dek, kek.version);
  const { size } = await stat(cipherPath);
  source.diskPath = cipherPath;
  source.size = size;

  if (debug) {
    console.log(`[DEBUG] Ciphertext size: ${(size / 1024 / 1024).toFixed(2)} MB`);
  }

  return { enc, cleanupDir };
}

/**
 * Disk-backed description of the binary to upload. Every upload path streams
 * from `diskPath` instead of materializing the file in memory — a 1.5 GB iOS
 * zip previously peaked at ~3 copies in RSS.
 */
interface UploadSource {
  /** MIME type sent with the upload. */
  contentType: string;
  /** Temp directory to delete once the upload finishes (only for .app dirs). */
  cleanupDir?: string;
  /** On-disk file all upload paths stream from. */
  diskPath: string;
  /** User-facing name (original path; .app dirs get '.zip' appended). */
  name: string;
  size: number;
}

/**
 * Prepares a file for upload: .app directories are zipped to a temp file on
 * disk; everything else is described in place. Nothing is read into memory.
 * @param filePath Path to the file to upload
 * @param debug Whether debug logging is enabled
 * @param startTime Timestamp when upload started
 * @returns Promise resolving to the upload source descriptor
 */
async function prepareFileForUpload(
  filePath: string,
  debug: boolean,
  startTime: number,
): Promise<UploadSource> {
  if (debug) {
    console.log('[DEBUG] Preparing file for upload...');
  }

  let source: UploadSource;

  if (filePath?.endsWith('.app')) {
    if (debug) {
      console.log('[DEBUG] Compressing .app folder to zip...');
    }

    // Validate that the .app directory exists before attempting to compress —
    // zipping a non-existent path silently produces an empty 22-byte zip.
    try {
      await access(filePath);
    } catch {
      // Provide helpful error message for common quoting issues
      const hasQuotes = filePath.includes("'") || filePath.includes('"');
      const errorMessage = [
        `App folder not found: ${filePath}`,
        '',
        hasQuotes
          ? 'Note: Your path contains quote characters. If the folder name has spaces, ensure quotes wrap the entire path:'
          : 'Note: If your folder name contains spaces, wrap the entire path in quotes:',
        hasQuotes
          ? `  ❌ Wrong: --app-file=./path/'My App Name.app'  (quotes become literal characters)`
          : `  Example: --app-file="./path/My App Name.app"`,
        hasQuotes
          ? `  ✅ Right: --app-file="./path/My App Name.app"   (quotes processed by shell)`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      throw new Error(errorMessage);
    }

    const { tempDir, zipPath } = await compressFolderToTempZip(filePath);
    const { size } = await stat(zipPath);
    source = {
      contentType: 'application/zip',
      cleanupDir: tempDir,
      diskPath: zipPath,
      name: filePath + '.zip',
      size,
    };

    if (debug) {
      console.log(`[DEBUG] Compressed file size: ${(size / 1024 / 1024).toFixed(2)} MB`);
    }
  } else {
    const { size } = await stat(filePath!);

    if (debug) {
      console.log(`[DEBUG] File size: ${(size / 1024 / 1024).toFixed(2)} MB`);
    }

    source = {
      contentType:
        mimeTypeLookupByExtension[filePath!.split('.').pop()!] ||
        'application/octet-stream',
      diskPath: filePath!,
      name: filePath!,
      size,
    };
  }

  if (debug) {
    console.log(`[DEBUG] File preparation completed in ${Date.now() - startTime}ms`);
  }

  return source;
}

/**
 * Calculates SHA-256 hash for a file
 * @param file File to calculate hash for
 * @param debug Whether debug logging is enabled
 * @param log Whether to log warnings
 * @returns Promise resolving to SHA-256 hash or undefined if failed
 */
async function calculateFileHash(
  source: UploadSource,
  debug: boolean,
  log: boolean,
): Promise<string | undefined> {
  try {
    if (debug) {
      console.log('[DEBUG] Calculating SHA-256 hash...');
    }

    const hashStartTime = Date.now();
    const sha = await getFileHashFromPath(source.diskPath);

    if (debug) {
      console.log(`[DEBUG] SHA-256 hash: ${sha}`);
      console.log(`[DEBUG] Hash calculation completed in ${Date.now() - hashStartTime}ms`);
    }

    return sha;
  } catch (error) {
    if (log) {
      console.warn('Warning: Failed to get file hash', error);
    }

    if (debug) {
      console.error('[DEBUG] Hash calculation failed:', error);
    }

    return undefined;
  }
}

/**
 * Checks whether a matching binary has already been uploaded.
 *
 * `lookup` is `{ sha }` for a plaintext upload, or `{ shaPlain, encrypted: true }`
 * for an encrypted one (dcd#1168) — see {@link ApiGateway.checkForExistingUpload}.
 *
 * When asking as an encrypting client, a hit is only honoured if the server
 * confirms the matched binary is itself encrypted. Any binary is a *plausible*
 * match on plaintext hash, including a previously-uploaded plaintext copy of the
 * same app, and reusing that would hand back an unencrypted binary while the user
 * had asked for encryption. The server applies the same predicate; this is the
 * client refusing to depend on that, so an older or misbehaving deployment
 * degrades into a redundant upload rather than a silent loss of encryption.
 *
 * @param apiUrl API base URL
 * @param auth AuthContext carrying request headers
 * @param lookup Dedup key — plaintext hash for encrypted uploads, else the sha
 * @param debug Whether debug logging is enabled
 * @returns Promise resolving to object with exists flag and optional binaryId
 */
async function checkExistingUpload(
  apiUrl: string,
  auth: AuthContext,
  lookup: { encrypted?: boolean; sha?: string; shaPlain?: string },
  debug: boolean,
): Promise<{ binaryId?: string; exists: boolean }> {
  try {
    if (debug) {
      console.log('[DEBUG] Checking for existing upload with matching SHA...');
      console.log(`[DEBUG] Lookup: ${JSON.stringify(lookup)}`);
      console.log(`[DEBUG] Target endpoint: ${apiUrl}/uploads/checkForExistingUpload`);
    }

    const shaCheckStartTime = Date.now();
    const { appBinaryId, encrypted, exists } = await ApiGateway.checkForExistingUpload(
      apiUrl,
      auth,
      lookup,
    );

    if (debug) {
      console.log(`[DEBUG] SHA check completed in ${Date.now() - shaCheckStartTime}ms`);
      console.log(`[DEBUG] Existing binary found: ${exists}`);
      if (exists) {
        console.log(`[DEBUG] Existing binary ID: ${appBinaryId}`);
      }
    }

    if (exists && lookup.encrypted && encrypted !== true) {
      if (debug) {
        console.log(
          '[DEBUG] Ignoring dedup hit: encryption was requested but the matched binary is not encrypted',
        );
      }

      return { exists: false };
    }

    return { binaryId: appBinaryId, exists };
  } catch (error) {
    // Invalid credentials will fail every subsequent request — surface now
    // rather than after the user has waited through a potentially huge upload.
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      throw error;
    }

    if (debug) {
      console.error('[DEBUG] === SHA CHECK FAILED ===');
      console.error('[DEBUG] Continuing with upload despite SHA check failure');
      console.error(`[DEBUG] Error type: ${error instanceof Error ? error.name : typeof error}`);
      console.error(`[DEBUG] Error message: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        console.error(`[DEBUG] Stack trace:\n${error.stack}`);
      }
    } else if (error instanceof Error && error.name === 'NetworkError') {
      // Even without debug, show a warning for network errors
      console.warn('\nWarning: Failed to check for existing binary upload (network error).');
      console.warn('Continuing with new upload...\n');
    }

    return { exists: false };
  }
}

interface PerformUploadConfig {
  auth: AuthContext;
  apiUrl: string;
  debug: boolean;
  /** Envelope metadata when the binary was encrypted (#1138); undefined otherwise. */
  enc?: BinaryEnvelope;
  filePath: string;
  sha: string | undefined;
  /**
   * Hash of the plaintext, set only for encrypted uploads (#1168). Persisted as
   * `binaries.sha_plain` so the next encrypted upload of this binary can dedup.
   */
  shaPlain?: string;
  source: UploadSource;
  startTime: number;
}

/**
 * Uploads file to Supabase using resumable uploads
 * @param env - Environment (dev or prod)
 * @param tempPath - Temporary staging path for upload
 * @param file - File to upload
 * @param debug - Enable debug logging
 * @returns Upload result with success status and any error
 */
async function uploadToSupabase(
  env: 'dev' | 'prod',
  tempPath: string,
  source: UploadSource,
  debug: boolean,
): Promise<{ error: Error | null; success: boolean }> {
  if (debug) {
    console.log(`[DEBUG] Uploading to Supabase storage (${env}) using resumable uploads...`);
    console.log(`[DEBUG] Staging path: ${tempPath}`);
    console.log(`[DEBUG] File size: ${(source.size / 1024 / 1024).toFixed(2)} MB`);
  }

  try {
    const uploadStartTime = Date.now();
    await SupabaseGateway.uploadResumable(env, tempPath, source, debug);

    if (debug) {
      const uploadDuration = Date.now() - uploadStartTime;
      const uploadDurationSeconds = uploadDuration / 1000;
      const uploadSpeed = (source.size / 1024 / 1024) / uploadDurationSeconds;
      console.log(`[DEBUG] Supabase resumable upload completed in ${uploadDurationSeconds.toFixed(2)}s (${uploadDuration}ms)`);
      console.log(`[DEBUG] Average upload speed: ${uploadSpeed.toFixed(2)} MB/s`);
    }

    return { error: null, success: true };
  } catch (error) {
    const uploadError = error instanceof Error ? error : new Error(String(error));
    if (debug) {
      console.error(`[DEBUG] === SUPABASE RESUMABLE UPLOAD FAILED ===`);
      console.error(`[DEBUG] Error message: ${uploadError.message}`);
      console.error(`[DEBUG] Error name: ${uploadError.name}`);
      if (uploadError.stack) {
        console.error(`[DEBUG] Error stack:\n${uploadError.stack}`);
      }

      console.error(`[DEBUG] Staging path: ${tempPath}`);
      console.error(`[DEBUG] File size: ${source.size} bytes`);
      console.log('[DEBUG] Will attempt Backblaze fallback if available...');
    }

    return { error: uploadError, success: false };
  }
}

interface BackblazeUploadConfig {
  auth: AuthContext;
  apiUrl: string;
  b2: { large?: unknown; simple?: unknown; strategy: string } | undefined;
  debug: boolean;
  finalPath: string;
  source: UploadSource;
}

/**
 * Handles Backblaze upload with appropriate strategy
 * @param config - Configuration object for Backblaze upload
 * @returns Upload result with success status and any error
 */
async function handleBackblazeUpload(config: BackblazeUploadConfig): Promise<{ error: Error | null; success: boolean }> {
  const { b2, apiUrl, auth, finalPath, source, debug } = config;
  if (!b2) {
    if (debug) {
      console.log('[DEBUG] Backblaze not configured, will fall back to Supabase');
    }

    return { error: null, success: false };
  }

  if (debug) {
    console.log('[DEBUG] Starting Backblaze upload (primary)...');
  }

  try {
    const b2UploadStartTime = Date.now();
    let backblazeSuccess = false;

    if (b2.strategy === 'simple' && b2.simple) {
      const simple = b2.simple as { authorizationToken: string; uploadUrl: string };
      backblazeSuccess = await uploadToBackblaze(
        simple.uploadUrl,
        simple.authorizationToken,
        `organizations/${finalPath}`,
        source,
        debug,
      );
    } else if (b2.strategy === 'large' && b2.large) {
      const large = b2.large as { fileId: string; uploadPartUrls: Array<{ authorizationToken: string; uploadUrl: string }> };
      backblazeSuccess = await uploadLargeFileToBackblaze({
        auth,
        apiUrl,
        debug,
        fileId: large.fileId,
        fileName: `organizations/${finalPath}`,
        filePath: source.diskPath,
        fileSize: source.size,
        uploadPartUrls: large.uploadPartUrls,
      });
    }

    if (debug) {
      const duration = Date.now() - b2UploadStartTime;
      const durationSeconds = duration / 1000;
      console.log(backblazeSuccess
        ? `[DEBUG] Backblaze upload completed successfully in ${durationSeconds.toFixed(2)}s (${duration}ms)`
        : `[DEBUG] Backblaze upload failed after ${durationSeconds.toFixed(2)}s (${duration}ms)`
      );
    }

    return { error: null, success: backblazeSuccess };
  } catch (error) {
    const b2Error = error instanceof Error ? error : new Error(String(error));
    if (debug) {
      console.error(`[DEBUG] === UNEXPECTED BACKBLAZE UPLOAD ERROR ===`);
      console.error(`[DEBUG] Error message: ${b2Error.message}`);
      console.error(`[DEBUG] Error name: ${b2Error.name}`);
      if (b2Error.stack) {
        console.error(`[DEBUG] Error stack:\n${b2Error.stack}`);
      }

      console.error(`[DEBUG] Upload strategy: ${b2.strategy}`);
    }

    return { error: b2Error, success: false };
  }
}

interface UploadPaths {
  b2: unknown;
  finalPath: string;
  id: string;
  tempPath: string;
}

/**
 * Requests upload URL and paths from API
 * @param apiUrl - API base URL
 * @param auth - AuthContext carrying request headers
 * @param filePath - Path to the file being uploaded
 * @param fileSize - Size of the file in bytes
 * @param debug - Enable debug logging
 * @returns Promise resolving to upload paths and configuration
 */
async function requestUploadPaths(
  apiUrl: string,
  auth: AuthContext,
  filePath: string,
  fileSize: number,
  debug: boolean,
): Promise<UploadPaths> {
  const platform = filePath?.endsWith('.apk') ? 'android' : 'ios';
  if (debug) {
    console.log('[DEBUG] Requesting upload URL...');
    console.log(`[DEBUG] Target endpoint: ${apiUrl}/uploads/getBinaryUploadUrl`);
    console.log(`[DEBUG] Platform: ${platform}`);
  }

  try {
    const urlRequestStartTime = Date.now();
    const { id, tempPath, finalPath, b2 } = await ApiGateway.getBinaryUploadUrl(apiUrl, auth, platform, fileSize);

    if (debug) {
      const hasStrategy = b2 && typeof b2 === 'object' && 'strategy' in b2;
      console.log(`[DEBUG] Upload URL request completed in ${Date.now() - urlRequestStartTime}ms`);
      console.log(`[DEBUG] Upload ID: ${id}`);
      console.log(`[DEBUG] Temp path (TUS upload): ${tempPath}`);
      console.log(`[DEBUG] Final path (after finalize): ${finalPath}`);
      console.log(`[DEBUG] Backblaze upload URL provided: ${Boolean(b2)}`);
      if (hasStrategy) console.log(`[DEBUG] Backblaze strategy: ${(b2 as { strategy: string }).strategy}`);
    }

    if (!tempPath) throw new Error('No upload path provided by API');

    return { b2, finalPath, id, tempPath };
  } catch (error) {
    if (debug) {
      console.error('[DEBUG] === FAILED TO GET UPLOAD URL ===');
      console.error(`[DEBUG] Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Add context to the error
    if (error instanceof Error) {
      if (error.name === 'NetworkError') {
        throw new Error(
          `Failed to request upload URL from API.\n\n${error.message}`,
          { cause: error }
        );
      }

      throw new Error(`Failed to request upload URL: ${error.message}`, {
        cause: error,
      });
    }

    throw error;
  }
}

/**
 * Extracts metadata from the binary file
 * @param filePath - Path to the binary file
 * @param debug - Enable debug logging
 * @returns Promise resolving to extracted metadata containing appId and platform
 */
async function extractBinaryMetadata(
  filePath: string,
  debug: boolean,
): Promise<TAppMetadata> {
  if (debug) console.log('[DEBUG] Extracting app metadata...');

  const metadataExtractor = new MetadataExtractorService();
  const metadata = await metadataExtractor.extract(filePath);

  if (!metadata) {
    throw new Error(`Failed to extract metadata from ${filePath}. Supported formats: .apk, .app, .zip`);
  }

  if (debug) console.log(`[DEBUG] Metadata extracted: ${JSON.stringify(metadata)}`);

  return metadata;
}

/**
 * Validates upload results and throws if all uploads failed
 * @param supabaseSuccess - Whether Supabase upload succeeded
 * @param backblazeSuccess - Whether Backblaze upload succeeded
 * @param lastError - Last error encountered during uploads
 * @param b2 - Backblaze configuration
 * @param debug - Enable debug logging
 * @returns void - throws error if all uploads failed
 */
function validateUploadResults(
  supabaseSuccess: boolean,
  backblazeSuccess: boolean,
  lastError: Error | null,
  b2: unknown,
  debug: boolean,
): void {
  if (supabaseSuccess || backblazeSuccess) {
    return;
  }

  if (debug) {
    console.error(`[DEBUG] === ALL UPLOADS FAILED ===`);
    console.error(`[DEBUG] Supabase upload: FAILED`);
    console.error(`[DEBUG] Backblaze upload: ${b2 ? 'FAILED' : 'NOT CONFIGURED'}`);
    if (lastError) {
      console.error(`[DEBUG] Final error details:`);
      console.error(`[DEBUG] - Message: ${lastError.message}`);
      console.error(`[DEBUG] - Name: ${lastError.name}`);
      console.error(`[DEBUG] - Stack: ${lastError.stack}`);
    }
  }

  throw new Error(
    `All uploads failed. ${lastError ? `Last error: ${JSON.stringify({ message: lastError.message, name: lastError.name, stack: lastError.stack })}` : 'No upload targets available.'}`
  );
}

/**
 * Performs the actual file upload
 * @param config Configuration object for the upload
 * @returns Promise resolving to upload ID
 */
async function performUpload(config: PerformUploadConfig): Promise<string> {
  const { filePath, apiUrl, auth, enc, source, sha, shaPlain, debug, startTime } = config;

  // Request upload URL and paths
  const { id, tempPath, finalPath, b2 } = await requestUploadPaths(apiUrl, auth, filePath, source.size, debug);

  // Extract app metadata from the original (plaintext) file. Attach the
  // envelope so it lands on binaries.metadata.enc (#1138).
  const metadata = await extractBinaryMetadata(filePath, debug);
  if (enc) {
    metadata.enc = enc;
  }

  const env = inferEnvFromApiUrl(apiUrl);

  // Upload to Backblaze first (primary)
  const backblazeResult = await handleBackblazeUpload({
    auth,
    apiUrl,
    b2: b2 as { large?: unknown; simple?: unknown; strategy: string } | undefined,
    debug,
    finalPath,
    source,
  });
  let lastError = backblazeResult.error;

  // Always upload to Supabase (re-enabled as always-on alongside Backblaze)
  if (debug) {
    console.log('[DEBUG] Uploading to Supabase...');
  }

  const supabaseResult: { error: Error | null; success: boolean } =
    await uploadToSupabase(env, tempPath, source, debug);
  if (!supabaseResult.success && supabaseResult.error) {
    lastError = supabaseResult.error;
  }

  // Validate results
  validateUploadResults(supabaseResult.success, backblazeResult.success, lastError, b2, debug);

  // Log upload summary
  if (debug) {
    console.log(`[DEBUG] Upload summary - Backblaze: ${backblazeResult.success ? '✓' : '✗'}, Supabase: ${supabaseResult.success ? '✓' : '✗'}`);
    console.log('[DEBUG] Finalizing upload...');
    console.log(`[DEBUG] Target endpoint: ${apiUrl}/uploads/finaliseUpload`);
    console.log(`[DEBUG] Uploaded to staging path: ${tempPath}`);
    console.log(`[DEBUG] API will move to final path: ${finalPath}`);
    console.log(`[DEBUG] Backblaze upload status: ${backblazeResult.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`[DEBUG] Supabase upload status: ${supabaseResult.success ? 'SUCCESS' : 'FAILED'}`);
    if (!backblazeResult.success && supabaseResult.success) console.log('[DEBUG] ⚠ Warning: File only exists in Supabase (Backblaze failed)');
  }

  // Finalize upload
  const finalizeStartTime = Date.now();
  await ApiGateway.finaliseUpload({
    auth,
    backblazeSuccess: backblazeResult.success,
    baseUrl: apiUrl,
    bytes: source.size,
    id,
    metadata,
    path: tempPath,
    // sha is undefined when hash calculation failed — omit it explicitly
    ...(sha ? { sha } : {}),
    ...(shaPlain ? { shaPlain } : {}),
    supabaseSuccess: supabaseResult.success,
  });

  if (debug) {
    console.log(`[DEBUG] Upload finalization completed in ${Date.now() - finalizeStartTime}ms`);
    console.log(`[DEBUG] Total upload time: ${Date.now() - startTime}ms`);
  }

  return id;
}

/**
 * Storage reference for an already-uploaded flow zip, threaded into the
 * `submitFlowTest` JSON body so the API can locate the staged file.
 */
export interface FlowZipUploadResult {
  backblazeSuccess: boolean;
  bytes: number;
  id: string;
  path: string;
  supabaseSuccess: boolean;
  useTus: boolean;
}

/**
 * Uploads an already-built flow zip directly to storage, mirroring the binary
 * client-direct path: getFlowUploadUrl → upload to storage (Backblaze if
 * offered + TUS to Supabase) → return the storage reference for submitFlowTest.
 *
 * The zip arrives as an in-memory Buffer (from `compressFilesFromRelativePath`);
 * it's written to a temp file so the exact same disk-streaming uploaders the
 * binary path uses can be reused unchanged. `supabaseSuccess`/`backblazeSuccess`
 * are reported honestly based on which uploads succeeded.
 *
 * Errors from `getFlowUploadUrl` propagate untouched so callers can detect a
 * 404 from an older API and fall back to the legacy multipart endpoint.
 */
export const uploadFlowZip = async (config: {
  apiUrl: string;
  auth: AuthContext;
  buffer: Buffer;
  debug?: boolean;
}): Promise<FlowZipUploadResult> => {
  const { apiUrl, auth, buffer, debug = false } = config;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dcd-flow-zip-'));
  const diskPath = path.join(tempDir, 'flowFile.zip');

  try {
    await writeFile(diskPath, buffer);

    const source: UploadSource = {
      contentType: 'application/zip',
      diskPath,
      name: 'flowFile.zip',
      size: buffer.length,
    };

    // Same response shape as getBinaryUploadUrl. A 404 here means the API
    // predates the client-direct flow path — let it propagate so the caller
    // falls back to the multipart endpoint.
    const { id, tempPath, finalPath, b2 } = await ApiGateway.getFlowUploadUrl(
      apiUrl,
      auth,
      buffer.length,
    );

    if (!tempPath) throw new Error('No upload path provided by API');

    const env = inferEnvFromApiUrl(apiUrl);

    // Upload to Backblaze first (primary, if configured)
    const backblazeResult = await handleBackblazeUpload({
      auth,
      apiUrl,
      b2: b2 as { large?: unknown; simple?: unknown; strategy: string } | undefined,
      debug,
      finalPath,
      source,
    });
    let lastError = backblazeResult.error;

    // Always upload to Supabase (always-on alongside Backblaze)
    const supabaseResult = await uploadToSupabase(env, tempPath, source, debug);
    if (!supabaseResult.success && supabaseResult.error) {
      lastError = supabaseResult.error;
    }

    validateUploadResults(supabaseResult.success, backblazeResult.success, lastError, b2, debug);

    if (debug) {
      console.log(`[DEBUG] Flow zip upload summary - Backblaze: ${backblazeResult.success ? '✓' : '✗'}, Supabase: ${supabaseResult.success ? '✓' : '✗'}`);
    }

    return {
      backblazeSuccess: backblazeResult.success,
      bytes: buffer.length,
      id,
      path: tempPath,
      supabaseSuccess: supabaseResult.success,
      useTus: true,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * Upload file to Backblaze using signed URL (simple upload for files < 100MB)
 * @param uploadUrl - Backblaze upload URL
 * @param authorizationToken - Authorization token for the upload
 * @param fileName - Name/path of the file
 * @param source - Upload source descriptor (streamed from disk)
 * @param debug - Whether debug logging is enabled
 * @returns Promise that resolves when upload completes or fails gracefully
 */
async function uploadToBackblaze(
  uploadUrl: string,
  authorizationToken: string,
  fileName: string,
  source: UploadSource,
  debug: boolean,
): Promise<boolean> {
  try {
    // The API only picks the simple strategy for small binaries (large files
    // get the multi-part path), so one transient buffer here is bounded.
    // S3 pre-signed PUTs reject chunked transfer encoding, which rules out a
    // plain stream body.
    const body = await readFile(source.diskPath);

    // Calculate SHA1 hash for Backblaze (B2 requires SHA1, not SHA256)
    const sha1 = createHash('sha1');
    sha1.update(body);
    const sha1Hex = sha1.digest('hex');

    // Detect if this is an S3 pre-signed URL (authorization token is empty)
    const isS3PreSignedUrl = !authorizationToken || authorizationToken === '';

    if (debug) {
      console.log(`[DEBUG] Uploading to Backblaze URL: ${uploadUrl}`);
      console.log(`[DEBUG] Upload method: ${isS3PreSignedUrl ? 'S3 pre-signed URL (PUT)' : 'B2 native API (POST)'}`);
      console.log(`[DEBUG] File name: ${fileName}`);
      console.log(`[DEBUG] File SHA1: ${sha1Hex}`);
    }

    // Build headers based on upload method
    const headers: Record<string, string> = {
      'Content-Length': body.length.toString(),
      'Content-Type': source.contentType || 'application/octet-stream',
      'X-Bz-Content-Sha1': sha1Hex,
    };

    // S3 pre-signed URLs have auth embedded in URL, native B2 uses Authorization header
    if (!isS3PreSignedUrl) {
      headers.Authorization = authorizationToken;
      headers['X-Bz-File-Name'] = encodeURIComponent(fileName);
    }

    const response = await fetch(uploadUrl, {
      // Zero-copy view over the buffer (new Uint8Array(buffer) would clone it).
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      headers,
      method: isS3PreSignedUrl ? 'PUT' : 'POST',
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (debug) {
        console.error(`[DEBUG] Backblaze upload failed with status ${response.status}: ${errorText}`);
      }

      // Don't throw and don't warn — Backblaze is the primary attempt and the
      // Supabase fallback usually recovers. A user-facing error is raised only
      // if every strategy fails (see validateUploadResults).
      return false;
    }

    if (debug) {
      console.log('[DEBUG] Backblaze upload successful');
    }

    return true;
  } catch (error) {
    if (debug) {
      console.error('[DEBUG] === BACKBLAZE UPLOAD EXCEPTION ===');
      console.error('[DEBUG] Backblaze upload exception:', error);
      console.error(`[DEBUG] Error type: ${error instanceof Error ? error.name : typeof error}`);
      console.error(`[DEBUG] Error message: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        console.error(`[DEBUG] Stack trace:\n${error.stack}`);
      }
    }

    // Provide more specific error messages for common network errors
    if (error instanceof TypeError && error.message === 'fetch failed') {
      if (debug) {
        console.error('[DEBUG] Network error detected - could be DNS, connection, or SSL issue');
      }
    }

    // Don't throw and don't warn — the Supabase fallback usually recovers, and
    // validateUploadResults raises a user-facing error only if all fail.
    return false;
  }
}

/**
 * Helper function to read a chunk from a file stream
 * @param filePath - Path to the file
 * @param start - Start byte position
 * @param end - End byte position (exclusive)
 * @returns Promise resolving to Buffer containing the chunk
 */
async function readFileChunk(filePath: string, start: number, end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end: end - 1 }); // end is inclusive in createReadStream

    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    stream.on('error', (error) => {
      reject(error);
    });
  });
}

interface LargeFileUploadConfig {
  auth: AuthContext;
  apiUrl: string;
  debug: boolean;
  fileId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  uploadPartUrls: Array<{ authorizationToken: string; uploadUrl: string }>;
}

/**
 * Calculates SHA1 hash for a buffer
 * @param buffer - Buffer to hash
 * @returns SHA1 hash as hex string
 */
function calculateSha1(buffer: Buffer): string {
  const sha1 = createHash('sha1');
  sha1.update(buffer);
  return sha1.digest('hex');
}

interface UploadPartConfig {
  authorizationToken: string;
  debug: boolean;
  partBuffer: Buffer;
  partLength: number;
  partNumber: number;
  sha1Hex: string;
  totalParts: number;
  uploadUrl: string;
}

/**
 * Uploads a single part to Backblaze
 * @param config - Configuration for the part upload
 * @returns Promise that resolves when upload completes
 */
async function uploadPartToBackblaze(config: UploadPartConfig): Promise<void> {
  const { uploadUrl, authorizationToken, partBuffer, partLength, sha1Hex, partNumber, totalParts, debug } = config;

  if (debug) {
    console.log(`[DEBUG] Uploading part ${partNumber}/${totalParts} (${(partLength / 1024 / 1024).toFixed(2)} MB, SHA1: ${sha1Hex})`);
  }

  try {
    const response = await fetch(uploadUrl, {
      body: new Uint8Array(partBuffer),
      headers: {
        Authorization: authorizationToken,
        'Content-Length': partLength.toString(),
        'X-Bz-Content-Sha1': sha1Hex,
        'X-Bz-Part-Number': partNumber.toString(),
      },
      method: 'POST',
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (debug) {
        console.error(`[DEBUG] Part ${partNumber} upload failed with status ${response.status}: ${errorText}`);
      }

      throw new Error(`Part ${partNumber} upload failed with status ${response.status}`);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === 'fetch failed') {
      if (debug) {
        console.error(`[DEBUG] Network error uploading part ${partNumber} - could be DNS, connection, or SSL issue`);
      }

      throw new Error(`Part ${partNumber} upload failed due to network error`, {
        cause: error,
      });
    }

    throw error;
  }

  if (debug) {
    console.log(`[DEBUG] Part ${partNumber}/${totalParts} uploaded successfully`);
  }
}

/**
 * Logs detailed error information for Backblaze upload failures
 * @param error - The error that occurred
 * @param debug - Whether debug logging is enabled
 * @returns void
 */
function logBackblazeUploadError(error: unknown, debug: boolean): void {
  if (debug) {
    console.error('[DEBUG] === BACKBLAZE LARGE FILE UPLOAD EXCEPTION ===');
    console.error('[DEBUG] Large file upload exception:', error);
    console.error(`[DEBUG] Error type: ${error instanceof Error ? error.name : typeof error}`);
    console.error(`[DEBUG] Error message: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(`[DEBUG] Stack trace:\n${error.stack}`);
    }
  }

  // No user-facing warning: Backblaze is the primary attempt and the Supabase
  // fallback usually recovers; validateUploadResults raises the only
  // user-facing error, and only when every strategy fails.
}

/**
 * Upload large file to Backblaze using multi-part upload with streaming (for files >= 5MB)
 * Uses file streaming to avoid loading entire file into memory, preventing OOM errors on large files
 * @param config - Configuration object for the large file upload
 * @returns Promise that resolves when upload completes or fails gracefully
 */
async function uploadLargeFileToBackblaze(config: LargeFileUploadConfig): Promise<boolean> {
  const { apiUrl, auth, fileId, uploadPartUrls, filePath, fileSize, debug } = config;
  try {
    const partSha1Array: string[] = [];
    const partSize = Math.ceil(fileSize / uploadPartUrls.length);

    if (debug) {
      console.log(`[DEBUG] Uploading large file in ${uploadPartUrls.length} parts (streaming mode)`);
      console.log(`[DEBUG] Part size: ${(partSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`[DEBUG] Reading from: ${filePath}`);
    }

    // Upload each part using streaming to avoid loading entire file into memory
    for (let i = 0; i < uploadPartUrls.length; i++) {
      const partNumber = i + 1;
      const start = i * partSize;
      const end = Math.min(start + partSize, fileSize);
      const partLength = end - start;

      if (debug) {
        console.log(`[DEBUG] Reading part ${partNumber}/${uploadPartUrls.length} bytes ${start}-${end}`);
      }

      const partBuffer = await readFileChunk(filePath, start, end);
      const sha1Hex = calculateSha1(partBuffer);
      partSha1Array.push(sha1Hex);

      await uploadPartToBackblaze({
        authorizationToken: uploadPartUrls[i].authorizationToken,
        debug,
        partBuffer,
        partLength,
        partNumber,
        sha1Hex,
        totalParts: uploadPartUrls.length,
        uploadUrl: uploadPartUrls[i].uploadUrl,
      });
    }

    if (debug) {
      console.log('[DEBUG] Finishing large file upload...');
      console.log(`[DEBUG] Finalizing ${partSha1Array.length} parts with fileId: ${fileId}`);
    }

    await ApiGateway.finishLargeFile(apiUrl, auth, fileId, partSha1Array);

    if (debug) console.log('[DEBUG] Large file upload completed successfully');

    return true;
  } catch (error) {
    logBackblazeUploadError(error, debug);
    return false;
  }
}

async function getFileHashFromPath(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }

  return hash.digest('hex');
}

/**
 * Writes JSON data to a file with error handling
 * @param filePath - Path to the output JSON file
 * @param data - Data to be serialized to JSON
 * @param logger - Logger object with log and warn methods
 * @returns true if successful, false if an error occurred
 */
export const writeJSONFile = (
  filePath: string,
  data: unknown,
  logger: { log: (message: string) => void; warn: (message: string) => void },
) => {
  try {
    const directory = path.dirname(filePath);
    if (directory !== '.') {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    logger.log(colors.dim('JSON output written to: ') + colors.highlight(path.resolve(filePath)));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isPermissionError = errorMessage.includes('EACCES') || errorMessage.includes('EPERM');
    const isNoSuchFileError = errorMessage.includes('ENOENT');

    logger.warn(colors.error(`Failed to write JSON output to file: ${filePath}`));

    if (isPermissionError) {
      logger.warn(colors.dim('   Permission denied - check file/directory write permissions'));
      logger.warn(colors.dim('   Try running with appropriate permissions or choose a different output location'));
    } else if (isNoSuchFileError) {
      logger.warn(colors.dim('   Directory does not exist - create the directory first or choose an existing path'));
    }

    logger.warn(colors.dim('   Error details: ') + errorMessage);
  }
};

/**
 * Formats duration in seconds into a human readable string
 * @param durationSeconds - Duration in seconds
 * @returns Formatted duration string (e.g. "2m 30s" or "45s")
 */
export const formatDurationSeconds = (durationSeconds: number): string => {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${durationSeconds}s`;
};
