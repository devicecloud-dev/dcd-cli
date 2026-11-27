import { createReadStream } from 'node:fs';

import * as tus from 'tus-js-client';

import { ENVIRONMENTS, type DcdEnvName } from '../config/environments.js';
import { getSupabaseKey, supabaseKeyHeaders } from '../config/supabase-key.js';
import { tusHttpStackOptions } from './fetch-http-stack.js';

/** Disk-backed upload descriptor — see UploadSource in src/methods.ts. */
export interface ResumableUploadSource {
  contentType: string;
  diskPath: string;
  name: string;
  size: number;
}

/**
 * A signed upload for one storage path, from the API's upload-URL response.
 * The token is sent as `x-signature` on every TUS request; it writes only
 * `path` and never overwrites an existing object.
 */
export interface SignedUpload {
  expiresInSeconds: number;
  path: string;
  token: string;
}

/** Refresh this long before the token says it expires. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** Fresh tokens one upload may ask for before it gives up. */
const MAX_TOKEN_REFRESHES = 5;
const RETRY_DELAYS = [0, 3000, 5000, 10_000, 20_000];

/**
 * Whether a TUS error response says the upload token was refused, which a
 * fresh token for the same path fixes. Storage answers with a 400 whose body
 * is the verifier's message, and those name no single word. Seen or expected:
 * - "Invalid signature" (wrong path, or a tampered token)
 * - "Invalid Compact JWS" (a token that is not a JWT at all)
 * - `"exp" claim timestamp check failed` (an expired token: the JWT library
 *   checks expiry before Storage's own "The provided token has expired.")
 */
const SIGNATURE_ERROR = /jwt|jws|signature|expired|"exp" claim/i;

export function isSignatureError(status: number, body: string): boolean {
  return [400, 401, 403].includes(status) && SIGNATURE_ERROR.test(body);
}

/** tus's own rule: retry anything but a 4xx, except 409 and 423. */
function defaultShouldRetry(status: number): boolean {
  return !(status >= 400 && status < 500) || status === 409 || status === 423;
}

export class SupabaseGateway {
  /**
   * Upload straight to the final storage path with a signed token, through
   * `/storage/v1/upload/resumable/sign`. No storage key of the client's own
   * is needed: the token is the permission.
   *
   * The token lasts a couple of hours and storage checks it on every
   * request, so a long or resumed upload can outlive it. Before each request
   * the token is refreshed when it is close to expiry, and a request refused
   * for its signature is retried with a fresh one. Either way it is the same
   * path, so the same TUS upload carries on.
   *
   * @param refreshToken - Asks the API for a fresh token for `signed.path`
   * @param options.storageUrl - Test seam; defaults to the environment's URL
   */
  static async uploadResumableSigned(
    env: DcdEnvName,
    signed: SignedUpload,
    source: ResumableUploadSource,
    refreshToken: (path: string) => Promise<SignedUpload>,
    debug = false,
    options: { retryDelays?: number[]; storageUrl?: string } = {},
  ): Promise<void> {
    const storageUrl = options.storageUrl ?? ENVIRONMENTS[env].supabase.url;
    const supabaseKey = await getSupabaseKey(env);

    let { token } = signed;
    let expiresAt = Date.now() + signed.expiresInSeconds * 1000;
    let stale = false;
    let refreshes = 0;
    let pending: Promise<void> | undefined;

    const margin = Math.min(REFRESH_MARGIN_MS, (signed.expiresInSeconds * 1000) / 2);
    const refresh = (): Promise<void> => {
      pending ??= (async () => {
        refreshes += 1;
        if (debug) console.log(`[DEBUG] Refreshing the upload token for ${signed.path}`);
        const fresh = await refreshToken(signed.path);
        token = fresh.token;
        expiresAt = Date.now() + fresh.expiresInSeconds * 1000;
        stale = false;
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    };

    await this.runTusUpload({
      debug,
      endpoint: `${storageUrl}/storage/v1/upload/resumable/sign`,
      // The gateway in front of Storage routes on the key; the token is the
      // permission, and the upload is checked against it, not the key.
      headers: supabaseKeyHeaders(supabaseKey),
      async onBeforeRequest(req) {
        if (stale || Date.now() >= expiresAt - margin) {
          await refresh();
        }

        req.setHeader('x-signature', token);
      },
      onShouldRetry(err) {
        const status = err.originalResponse?.getStatus() ?? 0;
        const body = err.originalResponse?.getBody() ?? '';
        if (isSignatureError(status, body)) {
          if (refreshes >= MAX_TOKEN_REFRESHES) return false;
          stale = true;
          return true;
        }

        return defaultShouldRetry(status);
      },
      path: signed.path,
      retryDelays: options.retryDelays ?? RETRY_DELAYS,
      source,
    });
  }

  /** One TUS upload of `source` to `path` in the organizations bucket. */
  private static runTusUpload(config: {
    debug: boolean;
    endpoint: string;
    headers: Record<string, string>;
    onBeforeRequest?: (req: tus.HttpRequest) => Promise<void> | void;
    onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
    onShouldRetry?: (err: tus.DetailedError) => boolean;
    path: string;
    retryDelays: number[];
    source: ResumableUploadSource;
  }): Promise<void> {
    const { debug, endpoint, headers, onBeforeRequest, onProgress, onShouldRetry, path, retryDelays, source } = config;

    if (debug) {
      console.log(`[DEBUG] Resumable upload starting...`);
      console.log(`[DEBUG] Endpoint: ${endpoint}`);
      console.log(`[DEBUG] Upload path: ${path}`);
      console.log(`[DEBUG] File name: ${source.name}`);
      console.log(`[DEBUG] File size: ${(source.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`[DEBUG] Streaming from disk: ${source.diskPath}`);
    }

    return new Promise((resolve, reject) => {
      // Stream from disk — tus only buffers one chunk at a time. uploadSize
      // is required because a stream's length can't be derived.
      const upload = new tus.Upload(createReadStream(source.diskPath), {
        uploadSize: source.size,

        // Bun's node:http can't send tus's create request; see FetchHttpStack.
        ...tusHttpStackOptions(),

        endpoint,
        retryDelays,
        headers,
        ...(onBeforeRequest ? { onBeforeRequest } : {}),
        ...(onShouldRetry ? { onShouldRetry } : {}),

        // Upload metadata
        metadata: {
          bucketName: 'organizations',
          objectName: path,
          contentType: source.contentType || 'application/octet-stream',
          cacheControl: '3600',
        },

        // Chunk size must be 6MB for Supabase
        chunkSize: 6 * 1024 * 1024,

        // Remove fingerprint on success to allow re-uploading identical files
        removeFingerprintOnSuccess: true,

        // Upload data during creation for better performance
        uploadDataDuringCreation: true,

        // Progress callback
        onProgress(bytesUploaded: number, bytesTotal: number) {
          if (debug) {
            const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
            console.log(
              `[DEBUG] Upload progress: ${(bytesUploaded / 1024 / 1024).toFixed(2)} MB / ${(bytesTotal / 1024 / 1024).toFixed(2)} MB (${percentage}%)`,
            );
          }

          // Call user-provided progress callback if available
          if (onProgress) {
            onProgress(bytesUploaded, bytesTotal);
          }
        },

        // Error handler
        onError(error: Error) {
          if (debug) {
            console.error(`[DEBUG] === RESUMABLE UPLOAD ERROR ===`);
            console.error(`[DEBUG] Error:`, error);
            console.error(`[DEBUG] Error message: ${error.message}`);
            if (error.stack) {
              console.error(`[DEBUG] Stack trace:\n${error.stack}`);
            }
          }

          reject(new Error(`Resumable upload failed: ${error.message}`));
        },

        // Success handler
        onSuccess() {
          if (debug) {
            console.log(`[DEBUG] Resumable upload completed successfully`);
            console.log(`[DEBUG] Upload path: ${path}`);
          }

          resolve();
        },
      });

      // Start the upload
      if (debug) {
        console.log(`[DEBUG] Starting TUS upload...`);
      }

      upload.start();
    });
  }

  /**
   * Upload to Supabase using resumable uploads (TUS protocol)
   * Uploads to staging location (uploads/{id}/) using the publishable key
   * File is later moved to final location by API after finalization
   * @param env - Environment (dev or prod)
   * @param path - Staging storage path (uploads/{id}/file.ext)
   * @param source - Upload source descriptor; the file is streamed from disk
   * @param debug - Enable debug logging
   * @param onProgress - Optional callback for upload progress (bytesUploaded, bytesTotal)
   * @returns Promise that resolves when upload completes
   */
  static async uploadResumable(
    env: DcdEnvName,
    path: string,
    source: ResumableUploadSource,
    debug = false,
    onProgress?: (bytesUploaded: number, bytesTotal: number) => void,
  ): Promise<void> {
    // Prod's Supabase URL is our own custom domain, so customers' networks
    // only need to reach devicecloud.dev, not supabase.co.
    const storageUrl = ENVIRONMENTS[env].supabase.url;
    const supabaseKey = await getSupabaseKey(env);

    return this.runTusUpload({
      debug,
      endpoint: `${storageUrl}/storage/v1/upload/resumable`,
      // Publishable key for staging uploads to uploads/* folder
      headers: {
        ...supabaseKeyHeaders(supabaseKey),
        'x-upsert': 'true', // Allow overwriting existing files
      },
      onProgress,
      path,
      retryDelays: RETRY_DELAYS,
      source,
    });
  }
}
