import { createReadStream } from 'node:fs';

import * as tus from 'tus-js-client';

import { ENVIRONMENTS, type DcdEnvName } from '../config/environments.js';
import { getSupabaseKey, supabaseKeyHeaders } from '../config/supabase-key.js';

/** Disk-backed upload descriptor — see UploadSource in src/methods.ts. */
export interface ResumableUploadSource {
  contentType: string;
  diskPath: string;
  name: string;
  size: number;
}

export class SupabaseGateway {
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

    if (debug) {
      console.log(`[DEBUG] Resumable upload starting...`);
      console.log(`[DEBUG] Storage URL: ${storageUrl}`);
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

        // TUS endpoint for Supabase Storage
        endpoint: `${storageUrl}/storage/v1/upload/resumable`,

        // Retry configuration - will retry 5 times with increasing delays
        retryDelays: [0, 3000, 5000, 10_000, 20_000],

        // Authentication and headers
        // Publishable key for staging uploads to uploads/* folder
        headers: {
          ...supabaseKeyHeaders(supabaseKey),
          'x-upsert': 'true', // Allow overwriting existing files
        },

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
}
