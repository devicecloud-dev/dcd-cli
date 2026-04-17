import * as path from 'node:path';

import { TAppMetadata } from '../types';
import type { AuthContext } from '../types/domain/auth.types';
import { paths } from '../types/generated/schema.types';

export const ApiGateway = {
  /**
   * Enhances generic "fetch failed" errors with more specific diagnostic information
   * @param error - The original TypeError from fetch
   * @param url - The URL that was being fetched
   * @returns Enhanced error with diagnostic information
   */
  enhanceFetchError(error: TypeError, url: string): Error {
    const urlObj = new URL(url);
    const {hostname, origin} = urlObj;

    let message = `Network request failed: ${url}\n\n`;
    message += `Possible causes:\n`;
    message += `  1. No internet connection - check your network connectivity\n`;
    message += `  2. DNS resolution failed - unable to resolve "${hostname}"\n`;
    message += `  3. Firewall or proxy blocking the request\n`;
    message += `  4. API server is down or unreachable\n`;
    message += `  5. SSL/TLS certificate validation failed\n\n`;
    message += `Troubleshooting steps:\n`;
    message += `  • Check internet connection: ping google.com\n`;
    message += `  • Test API reachability: curl ${origin}\n`;
    message += `  • Verify API URL is correct: ${origin}\n`;
    message += `  • Check for proxy/VPN interference\n`;
    message += `  • Try again in a few moments if server is temporarily down\n\n`;
    message += `Original error: ${error.message}`;

    const enhancedError = new Error(message);
    enhancedError.name = 'NetworkError';
    enhancedError.stack = error.stack;
    return enhancedError;
  },

  /**
   * Standardized error handling for API responses
   * @param res - The fetch response object
   * @param operation - Description of the operation that failed
   * @returns Never returns, always throws
   */
  async handleApiError(res: Response, operation: string): Promise<never> {
    const errorText = await res.text();
    let userMessage: string;

    // Parse common API error formats
    try {
      const errorData = JSON.parse(errorText);
      userMessage = errorData.message || errorData.error || errorText;
    } catch {
      userMessage = errorText;
    }

    // Add context and improve readability
    switch (res.status) {
      case 400: {
        throw new Error(`Invalid request: ${userMessage}`);
      }

      case 401: {
        throw new Error(`Authentication failed. Please check your API key.`);
      }

      case 403: {
        // For 403, use the server's error message directly as it's now detailed
        // If the message suggests an API key issue, provide additional guidance
        if (userMessage.toLowerCase().includes('api key')) {
          throw new Error(
            `${userMessage}\n\nTroubleshooting steps:\n` +
              `  1. Verify DEVICE_CLOUD_API_KEY environment variable is set\n` +
              `  2. Check you're using the correct API key for this environment\n` +
              `  3. Ensure the API key hasn't been deleted or revoked\n` +
              `  4. Confirm you're connecting to the correct API URL`,
          );
        }

        throw new Error(`Access denied. ${userMessage}`);
      }

      case 404: {
        throw new Error(`Resource not found. ${userMessage}`);
      }

      case 429: {
        throw new Error(`Rate limit exceeded. Please try again later.`);
      }

      case 500: {
        throw new Error(`Server error occurred. Please try again or contact support.`);
      }

      default: {
        throw new Error(`${operation} failed: ${userMessage} (HTTP ${res.status})`);
      }
    }
  },
  async checkForExistingUpload(
    baseUrl: string,
    auth: AuthContext,
    sha: string,
  ) {
    try {
      const res = await fetch(`${baseUrl}/uploads/checkForExistingUpload`, {
        body: JSON.stringify({ sha }),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });

      if (!res.ok) {
        await this.handleApiError(res, 'Failed to check for existing upload');
      }

      return res.json() as Promise<
        paths['/uploads/checkForExistingUpload']['post']['responses']['201']['content']['application/json']
      >;
    } catch (error) {
      // Handle network-level errors (DNS, connection refused, timeout, etc.)
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/uploads/checkForExistingUpload`);
      }

      throw error;
    }
  },

   
  async downloadArtifactsZip(
    baseUrl: string,
    auth: AuthContext,
    uploadId: string,
    results: 'ALL' | 'FAILED',
    artifactsPath: string = './artifacts.zip',
  ) {
    try {
      const res = await fetch(`${baseUrl}/results/${uploadId}/download`, {
        body: JSON.stringify({ results }),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to download artifacts');
      }

    // Handle tilde expansion for home directory
    if (artifactsPath.startsWith('~/') || artifactsPath === '~') {
      artifactsPath = artifactsPath.replace(
        /^~(?=$|\/|\\)/,
        // eslint-disable-next-line unicorn/prefer-module
        require('node:os').homedir(),
      );
    }

    // Create directory structure if it doesn't exist
    // eslint-disable-next-line unicorn/prefer-module
    const { dirname } = require('node:path');
    // eslint-disable-next-line unicorn/prefer-module
    const { createWriteStream, mkdirSync } = require('node:fs');
    // eslint-disable-next-line unicorn/prefer-module
    const { finished } = require('node:stream/promises');
    // eslint-disable-next-line unicorn/prefer-module
    const { Readable } = require('node:stream');

    const directory = dirname(artifactsPath);
    if (directory !== '.') {
      try {
        mkdirSync(directory, { recursive: true });
      } catch (error) {
        // Ignore if directory already exists
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }

    const fileStream = createWriteStream(artifactsPath, { flags: 'w' });

    await finished(Readable.fromWeb(res.body).pipe(fileStream));
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/results/${uploadId}/download`);
      }

      throw error;
    }
  },

  async finaliseUpload(config: {
    auth: AuthContext;
    backblazeSuccess: boolean;
    baseUrl: string;
    bytes: number;
    id: string;
    metadata: TAppMetadata;
    path: string;
    sha: string;
    supabaseSuccess: boolean;
  }) {
    const { baseUrl, auth, id, metadata, path, sha, supabaseSuccess, backblazeSuccess, bytes } = config;
    try {
      const res = await fetch(`${baseUrl}/uploads/finaliseUpload`, {
        body: JSON.stringify({
          backblazeSuccess,
          bytes,
          id,
          metadata,
          path, // This is tempPath for TUS uploads
          sha,
          supabaseSuccess,
        }),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to finalize upload');
      }

      return res.json() as Promise<
        paths['/uploads/finaliseUpload']['post']['responses']['201']['content']['application/json']
      >;
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/uploads/finaliseUpload`);
      }

      throw error;
    }
  },

  async getBinaryUploadUrl(
    baseUrl: string,
    auth: AuthContext,
    platform: 'android' | 'ios',
    fileSize: number,
  ) {
    try {
      const res = await fetch(`${baseUrl}/uploads/getBinaryUploadUrl`, {
        body: JSON.stringify({ platform, fileSize }),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to get upload URL');
      }

      return res.json() as Promise<
        paths['/uploads/getBinaryUploadUrl']['post']['responses']['201']['content']['application/json']
      >;
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/uploads/getBinaryUploadUrl`);
      }

      throw error;
    }
  },

  async finishLargeFile(
    baseUrl: string,
    auth: AuthContext,
    fileId: string,
    partSha1Array: string[],
  ) {
    try {
      const res = await fetch(`${baseUrl}/uploads/finishLargeFile`, {
        body: JSON.stringify({ fileId, partSha1Array }),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to finish large file');
      }

      return res.json();
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/uploads/finishLargeFile`);
      }

      throw error;
    }
  },

  async getResultsForUpload(
    baseUrl: string,
    auth: AuthContext,
    uploadId: string,
  ) {
    // TODO: merge with getUploadStatus
    try {
      const res = await fetch(`${baseUrl}/results/${uploadId}`, {
        headers: { ...auth.headers },
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to get results');
      }

      return res.json() as Promise<
        paths['/results/{uploadId}']['get']['responses']['200']['content']['application/json']
      >;
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/results/${uploadId}`);
      }

      throw error;
    }
  },

  async getUploadStatus(
    baseUrl: string,
    auth: AuthContext,
    options: { name?: string; uploadId?: string },
  ) {
    const queryParams = new URLSearchParams();
    if (options.uploadId) {
      queryParams.append('uploadId', options.uploadId);
    }

    if (options.name) {
      queryParams.append('name', options.name);
    }

    try {
      const response = await fetch(`${baseUrl}/uploads/status?${queryParams}`, {
        headers: {
          ...auth.headers,
        },
      });

      if (!response.ok) {
        await this.handleApiError(response, 'Failed to get upload status');
      }

      return response.json() as Promise<{
        createdAt?: string;
        name?: string;
        status: 'CANCELLED' | 'FAILED' | 'PASSED' | 'PENDING';
        tests: Array<{
          createdAt?: string;
          durationSeconds?: number;
          failReason?: string;
          name: string;
          status: 'CANCELLED' | 'FAILED' | 'PASSED' | 'PENDING';
        }>;
      }>;
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/uploads/status?${queryParams}`);
      }

      throw error;
    }
  },

  async listUploads(
    baseUrl: string,
    auth: AuthContext,
    options: {
      from?: string;
      limit?: number;
      name?: string;
      offset?: number;
      to?: string;
    } = {},
  ) {
    const queryParams = new URLSearchParams();
    if (options.name) {
      queryParams.append('name', options.name);
    }

    if (options.from) {
      queryParams.append('from', options.from);
    }

    if (options.to) {
      queryParams.append('to', options.to);
    }

    if (options.limit !== undefined) {
      queryParams.append('limit', String(options.limit));
    }

    if (options.offset !== undefined) {
      queryParams.append('offset', String(options.offset));
    }

    const url = `${baseUrl}/uploads/list?${queryParams}`;

    try {
      const response = await fetch(url, {
        headers: {
          ...auth.headers,
        },
      });

      if (!response.ok) {
        await this.handleApiError(response, 'Failed to list uploads');
      }

      return response.json() as Promise<{
        limit: number;
        offset: number;
        total: number;
        uploads: Array<{
          consoleUrl: string;
          created_at: string;
          id: string;
          name: null | string;
        }>;
      }>;
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, url);
      }

      throw error;
    }
  },

  async uploadFlow(
    baseUrl: string,
    auth: AuthContext,
    testFormData: FormData,
  ) {
    try {
      const res = await fetch(`${baseUrl}/uploads/flow`, {
        body: testFormData,
        headers: {
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to upload test flows');
      }

      return res.json() as Promise<
        paths['/uploads/flow']['post']['responses']['201']['content']['application/json']
      >;
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/uploads/flow`);
      }

      throw error;
    }
  },


  /**
   * Generic report download method that handles both junit and allure reports
   * @param baseUrl - API base URL
   * @param auth - AuthContext (API key or Bearer session) for authentication
   * @param uploadId - Upload ID to download report for
   * @param reportType - Type of report to download ('junit' or 'allure')
   * @param reportPath - Optional custom path for the downloaded report
   * @returns Promise that resolves when download is complete
   */
  async downloadReportGeneric(
    baseUrl: string,
    auth: AuthContext,
    uploadId: string,
    reportType: 'allure' | 'html' | 'junit',
    reportPath?: string,
  ) {
    // Define endpoint and default filename mappings
    const config = {
      junit: {
        endpoint: `/results/${uploadId}/report`,
        defaultFilename: `report-${uploadId}.xml`,
        notFoundMessage: `Upload ID '${uploadId}' not found or no results available for this upload`,
        errorPrefix: 'Failed to download report',
      },
      allure: {
        endpoint: `/allure/${uploadId}/download`,
        defaultFilename: `report-${uploadId}.html`,
        notFoundMessage: `Upload ID '${uploadId}' not found or no Allure report available for this upload`,
        errorPrefix: 'Failed to download Allure report',
      },
      html: {
        endpoint: `/results/${uploadId}/html-report`,
        defaultFilename: `report-${uploadId}.html`,
        notFoundMessage: `Upload ID '${uploadId}' not found or no HTML report available for this upload`,
        errorPrefix: 'Failed to download HTML report',
      },
    };

    const { endpoint, defaultFilename, notFoundMessage, errorPrefix } = config[reportType];
    const finalReportPath = reportPath || path.resolve(process.cwd(), defaultFilename);
    const url = `${baseUrl}${endpoint}`;

    try {
      // Make the download request
      const res = await fetch(url, {
        headers: {
          ...auth.headers,
        },
        method: 'GET',
      });

      if (!res.ok) {
        const errorText = await res.text();
        if (res.status === 404) {
          throw new Error(notFoundMessage);
        }

        throw new Error(`${errorPrefix}: ${res.status} ${errorText}`);
      }

    // Handle tilde expansion for home directory (applies to all report types)
    let expandedPath = finalReportPath;
    if (finalReportPath.startsWith('~/') || finalReportPath === '~') {
      expandedPath = finalReportPath.replace(
        /^~/,
        // eslint-disable-next-line unicorn/prefer-module
        require('node:os').homedir(),
      );
    }

    // Create directory structure if it doesn't exist
    // eslint-disable-next-line unicorn/prefer-module
    const { dirname } = require('node:path');
    // eslint-disable-next-line unicorn/prefer-module
    const { createWriteStream, mkdirSync } = require('node:fs');
    // eslint-disable-next-line unicorn/prefer-module
    const { finished } = require('node:stream/promises');
    // eslint-disable-next-line unicorn/prefer-module
    const { Readable } = require('node:stream');

    const directory = dirname(expandedPath);

    if (directory !== '.') {
      try {
        mkdirSync(directory, { recursive: true });
      } catch (error) {
        // Ignore EEXIST errors (directory already exists)
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
    }

    // Write the file using streaming for better memory efficiency
    // Use 'w' flag to overwrite existing files instead of failing
    const fileStream = createWriteStream(expandedPath, { flags: 'w' });
    await finished(Readable.fromWeb(res.body).pipe(fileStream));
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, url);
      }

      throw error;
    }
  },
};
