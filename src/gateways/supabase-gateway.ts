import { createClient } from '@supabase/supabase-js';
import * as tus from 'tus-js-client';

import { ENVIRONMENTS, type DcdEnvName } from '../config/environments';

export class SupabaseGateway {
  /**
   * Upload to Supabase using resumable uploads (TUS protocol)
   * Uploads to staging location (uploads/{id}/) using anon key
   * File is later moved to final location by API after finalization
   * @param env - Environment (dev or prod)
   * @param path - Staging storage path (uploads/{id}/file.ext)
   * @param file - File to upload
   * @param debug - Enable debug logging
   * @param onProgress - Optional callback for upload progress (bytesUploaded, bytesTotal)
   * @returns Promise that resolves when upload completes
   */
  static async uploadResumable(
    env: DcdEnvName,
    path: string,
    file: File,
    debug = false,
    onProgress?: (bytesUploaded: number, bytesTotal: number) => void,
  ): Promise<void> {
    const { url: SUPABASE_URL, anonKey: SUPABASE_PUBLIC_KEY, projectRef } =
      ENVIRONMENTS[env].supabase;
    const storageUrl = `https://${projectRef}.storage.supabase.co`;

    if (debug) {
      console.log(`[DEBUG] Resumable upload starting...`);
      console.log(`[DEBUG] Storage URL: ${storageUrl}`);
      console.log(`[DEBUG] Upload path: ${path}`);
      console.log(`[DEBUG] File name: ${file.name}`);
      console.log(`[DEBUG] File size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
    }

    // Convert File to Buffer for Node.js tus-js-client
    // In Node.js environment, tus-js-client expects Buffer or Readable stream, not File
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    if (debug) {
      console.log(`[DEBUG] Converted File to Buffer (${fileBuffer.length} bytes)`);
    }

    return new Promise((resolve, reject) => {
      const upload = new tus.Upload(fileBuffer, {
        // TUS endpoint for Supabase Storage
        endpoint: `${storageUrl}/storage/v1/upload/resumable`,

        // Retry configuration - will retry 5 times with increasing delays
        retryDelays: [0, 3000, 5000, 10_000, 20_000],

        // Authentication and headers
        // Use anon key for staging uploads to uploads/* folder
        headers: {
          authorization: `Bearer ${SUPABASE_PUBLIC_KEY}`,
          'x-upsert': 'true', // Allow overwriting existing files
        },

        // Upload metadata
        metadata: {
          bucketName: 'organizations',
          objectName: path,
          contentType: file.type || 'application/octet-stream',
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

  static async uploadToSignedUrl(
    env: DcdEnvName,
    path: string,
    token: string,
    file: File,
    debug = false,
  ) {
    const { url: SUPABASE_URL, anonKey: SUPABASE_PUBLIC_KEY } = ENVIRONMENTS[env].supabase;

    if (debug) {
      console.log(`[DEBUG] Supabase upload starting...`);
      console.log(`[DEBUG] Supabase URL: ${SUPABASE_URL}`);
      console.log(`[DEBUG] Upload path: ${path}`);
      console.log(`[DEBUG] File name: ${file.name}`);
      console.log(`[DEBUG] File type: ${file.type}`);
    }

    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY);
      const uploadToUrl = await supabase.storage
        .from('organizations')
        .uploadToSignedUrl(path, token, file);

      if (uploadToUrl.error) {
        const error = uploadToUrl.error as
          | { message?: string; statusCode?: number | string }
          | string;
        const errorMessage =
          typeof error === 'string' ? error : error?.message || 'Upload failed';

        if (debug) {
          console.error(`[DEBUG] Supabase upload error:`, error);
          if (typeof error === 'object' && 'statusCode' in error) {
            console.error(`[DEBUG] HTTP Status Code: ${error.statusCode}`);
          }
        }

        throw new Error(errorMessage);
      }

      if (debug) {
        console.log(`[DEBUG] Supabase upload successful`);
        console.log(
          `[DEBUG] Upload result path: ${uploadToUrl.data?.path || 'N/A'}`,
        );
      }
    } catch (error) {
      if (debug) {
        this.logUploadException(error, env, SUPABASE_URL, path, file);
      }

      // Re-throw with additional context
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Supabase upload error: ${errorMsg}`);
    }
  }

  /**
   * Logs network error details for debugging
   * @param error - Error object to analyze for network-related issues
   * @returns void
   */
  private static logNetworkError(error: Error): void {
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('econnrefused') || errorMsg.includes('connection refused')) {
      console.error(
        `[DEBUG] Network error: Connection refused - check internet connectivity`,
      );
    } else if (errorMsg.includes('etimedout') || errorMsg.includes('timeout')) {
      console.error(
        `[DEBUG] Network error: Connection timeout - check internet connectivity or try again`,
      );
    } else if (errorMsg.includes('enotfound') || errorMsg.includes('not found')) {
      console.error(
        `[DEBUG] Network error: DNS lookup failed - check internet connectivity`,
      );
    } else if (errorMsg.includes('econnreset') || errorMsg.includes('connection reset') || errorMsg.includes('connection lost')) {
      console.error(
        `[DEBUG] Network error: Connection reset/lost - network unstable or interrupted`,
      );
    } else if (errorMsg.includes('network')) {
      console.error(
        `[DEBUG] Network-related error detected - check internet connectivity`,
      );
    }
  }

  /**
   * Logs upload exception details for debugging
   * @param error - Exception that occurred during upload
   * @param env - Environment (dev or prod)
   * @param supabaseUrl - Supabase URL being used
   * @param path - Upload path
   * @param file - File being uploaded
   * @returns void
   */
  private static logUploadException(
    error: unknown,
    env: string,
    supabaseUrl: string,
    path: string,
    file: File,
  ): void {
    console.error(`[DEBUG] === SUPABASE UPLOAD EXCEPTION ===`);
    console.error(`[DEBUG] Exception caught:`, error);
    console.error(
      `[DEBUG] Error type: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    console.error(
      `[DEBUG] Error message: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    if (error instanceof Error && error.stack) {
      console.error(`[DEBUG] Error stack:\n${error.stack}`);
    }

    // Log additional context
    console.error(`[DEBUG] Upload context:`);
    console.error(`[DEBUG] - Environment: ${env}`);
    console.error(`[DEBUG] - Supabase URL: ${supabaseUrl}`);
    console.error(`[DEBUG] - Upload path: ${path}`);
    console.error(`[DEBUG] - File name: ${file.name}`);
    console.error(`[DEBUG] - File size: ${file.size} bytes`);

    // Check for common network errors
    if (error instanceof Error) {
      this.logNetworkError(error);
    }
  }
}
