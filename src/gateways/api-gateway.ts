import { createWriteStream, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { TAppMetadata } from '../types.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import type {
  LiveCommandStatus,
  LiveExecResult,
  LiveSession,
  LiveSessionSummary,
} from '../types/domain/live.types.js';
import { components, paths } from '../types/generated/schema.types.js';

/**
 * Error thrown for non-OK API responses, carrying the HTTP status so callers
 * can branch on auth failures etc. without string matching.
 */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Parses a successful response body as JSON, wrapping parse failures in a
 * descriptive error (a 200 with an HTML body otherwise surfaces as a bare
 * SyntaxError with no context about which call failed).
 */
async function parseJsonResponse<T>(res: Response, operation: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (error) {
    throw new Error(
      `${operation}: API returned an invalid JSON response (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
}

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
        throw new ApiError(`Invalid request: ${userMessage}`, 400);
      }

      case 401: {
        // Auth-mode-neutral: the CLI accepts both API keys and Bearer sessions.
        // status.ts matches on the "Authentication failed" / "API key" substrings.
        let message =
          `Authentication failed — your credentials are invalid or expired. ` +
          `Re-run \`dcd login\` or check your API key. (${operation})`;
        if (userMessage) {
          message += `\nServer response: ${userMessage}`;
        }

        throw new ApiError(message, 401);
      }

      case 403: {
        // For 403, use the server's error message directly as it's now detailed
        // If the message suggests an API key issue, provide additional guidance
        if (userMessage.toLowerCase().includes('api key')) {
          throw new ApiError(
            `${userMessage}\n\nTroubleshooting steps:\n` +
              `  1. Verify DEVICE_CLOUD_API_KEY environment variable is set\n` +
              `  2. Check you're using the correct API key for this environment\n` +
              `  3. Ensure the API key hasn't been deleted or revoked\n` +
              `  4. Confirm you're connecting to the correct API URL`,
            403,
          );
        }

        throw new ApiError(`Access denied. ${userMessage}`, 403);
      }

      case 404: {
        throw new ApiError(`Resource not found. ${userMessage}`, 404);
      }

      case 429: {
        throw new ApiError(`Rate limit exceeded. Please try again later. (${operation})`, 429);
      }

      case 500: {
        throw new ApiError(`Server error occurred. Please try again or contact support. (${operation})`, 500);
      }

      default: {
        // `operation` is already phrased as "Failed to …", so don't append
        // another "failed" here (avoids "Failed to execute test failed: …").
        throw new ApiError(`${operation}: ${userMessage} (HTTP ${res.status})`, res.status);
      }
    }
  },

  /**
   * Streams a fetch response body to disk, expanding a leading tilde and
   * creating the destination directory if needed. Internal helper shared by
   * the download methods.
   */
  async streamResponseToFile(res: Response, destinationPath: string, operation: string) {
    if (res.body === null) {
      throw new Error(`${operation}: server response contained no body to download`);
    }

    // Handle tilde expansion for home directory
    const expandedPath = destinationPath.replace(/^~(?=$|\/|\\)/, homedir());

    // Create directory structure if it doesn't exist
    const directory = path.dirname(expandedPath);
    if (directory !== '.') {
      mkdirSync(directory, { recursive: true });
    }

    // Use 'w' flag to overwrite existing files instead of failing.
    // pipeline (unlike .pipe) propagates source-stream errors, so a
    // mid-download network failure rejects instead of hanging forever.
    const fileStream = createWriteStream(expandedPath, { flags: 'w' });
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      fileStream,
    );
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

      return await parseJsonResponse<
        paths['/uploads/checkForExistingUpload']['post']['responses']['201']['content']['application/json']
      >(res, 'Failed to check for existing upload');
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

      await this.streamResponseToFile(res, artifactsPath, 'Failed to download artifacts');
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
    sha?: string;
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
          ...(sha ? { sha } : {}),
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

      return await parseJsonResponse<
        paths['/uploads/finaliseUpload']['post']['responses']['201']['content']['application/json']
      >(res, 'Failed to finalize upload');
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

      return await parseJsonResponse<
        paths['/uploads/getBinaryUploadUrl']['post']['responses']['201']['content']['application/json']
      >(res, 'Failed to get upload URL');
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

      return await parseJsonResponse<unknown>(res, 'Failed to finish large file');
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

      return await parseJsonResponse<
        paths['/results/{uploadId}']['get']['responses']['200']['content']['application/json']
      >(res, 'Failed to get results');
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

      return await parseJsonResponse<{
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
      }>(response, 'Failed to get upload status');
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

      return await parseJsonResponse<{
        limit: number;
        offset: number;
        total: number;
        uploads: Array<{
          consoleUrl: string;
          created_at: string;
          id: string;
          name: null | string;
        }>;
      }>(response, 'Failed to list uploads');
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

      return await parseJsonResponse<
        paths['/uploads/flow']['post']['responses']['201']['content']['application/json']
      >(res, 'Failed to upload test flows');
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/uploads/flow`);
      }

      throw error;
    }
  },

  /**
   * Requests a storage URL for a client-direct flow zip upload. Mirrors
   * `getBinaryUploadUrl` (same response shape) but stages the zip under
   * `<orgId>/tests/` instead of the app-binary path. A 404 here means the API
   * predates the client-direct flow path — callers fall back to `uploadFlow`.
   */
  async getFlowUploadUrl(
    baseUrl: string,
    auth: AuthContext,
    fileSize: number,
  ) {
    try {
      const res = await fetch(`${baseUrl}/uploads/getFlowUploadUrl`, {
        body: JSON.stringify({ fileSize, useTus: true }),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to get flow upload URL');
      }

      // Same response shape as getBinaryUploadUrl: { id, tempPath, finalPath, path, b2?, token? }.
      return await parseJsonResponse<
        components['schemas']['IGetBinaryUploadUrlResponse']
      >(res, 'Failed to get flow upload URL');
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/uploads/getFlowUploadUrl`);
      }

      throw error;
    }
  },

  /**
   * Submits a flow test that references an already-uploaded zip (JSON body, no
   * multipart). The response is identical to the legacy `POST /uploads/flow`.
   * A 404 means the API predates this endpoint — callers fall back to
   * `uploadFlow`.
   */
  async submitFlowTest(
    baseUrl: string,
    auth: AuthContext,
    body: Record<string, unknown>,
  ) {
    try {
      const res = await fetch(`${baseUrl}/uploads/submitFlowTest`, {
        body: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to submit test flows');
      }

      // Identical response to the legacy multipart POST /uploads/flow.
      return await parseJsonResponse<{
        message?: string;
        results?: components['schemas']['IDBResult'][];
      }>(res, 'Failed to submit test flows');
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/uploads/submitFlowTest`);
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

      await this.streamResponseToFile(res, finalReportPath, errorPrefix);
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, url);
      }

      throw error;
    }
  },

  async startLiveSession(
    baseUrl: string,
    auth: AuthContext,
    params: {
      binaryUploadId?: string;
      deviceLocale?: string;
      platform: string;
      androidDevice?: string;
      androidApiLevel?: string;
    },
  ): Promise<LiveSessionSummary> {
    try {
      const res = await fetch(`${baseUrl}/live`, {
        body: JSON.stringify({
          binaryUploadId: params.binaryUploadId,
          deviceLocale: params.deviceLocale,
          platform: params.platform,
          androidDevice: params.androidDevice,
          androidApiLevel: params.androidApiLevel,
        }),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to start live session');
      }

      return await parseJsonResponse<LiveSessionSummary>(res, 'Failed to start live session');
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, `${baseUrl}/live`);
      }

      throw error;
    }
  },

  async installLiveBinary(
    baseUrl: string,
    auth: AuthContext,
    sessionName: string,
    binaryUploadId: string,
  ): Promise<void> {
    const url = `${baseUrl}/live/${sessionName}/install`;
    try {
      const res = await fetch(url, {
        body: JSON.stringify({ binaryUploadId }),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to install binary');
      }
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, url);
      }

      throw error;
    }
  },

  async execLiveYaml(
    baseUrl: string,
    auth: AuthContext,
    sessionName: string,
    yaml: string,
    opts: { async?: boolean } = {},
  ): Promise<LiveExecResult> {
    const url = `${baseUrl}/live/${sessionName}/exec`;
    try {
      const res = await fetch(url, {
        body: JSON.stringify({ yaml, async: opts.async }),
        headers: {
          'content-type': 'application/json',
          ...auth.headers,
        },
        method: 'POST',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to execute test');
      }

      return await parseJsonResponse<LiveExecResult>(res, 'Failed to execute test');
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, url);
      }

      throw error;
    }
  },

  async getLiveCommand(
    baseUrl: string,
    auth: AuthContext,
    sessionName: string,
    commandId: string,
  ): Promise<LiveCommandStatus> {
    const url = `${baseUrl}/live/${sessionName}/commands/${commandId}`;
    try {
      const res = await fetch(url, { headers: { ...auth.headers }, method: 'GET' });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to get command status');
      }
      return await parseJsonResponse<LiveCommandStatus>(res, 'Failed to get command status');
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, url);
      }

      throw error;
    }
  },

  async keepaliveLiveSession(
    baseUrl: string,
    auth: AuthContext,
    sessionName: string,
  ): Promise<void> {
    const url = `${baseUrl}/live/${sessionName}/keepalive`;
    try {
      const res = await fetch(url, { headers: { ...auth.headers }, method: 'POST' });
      // A keepalive failure shouldn't kill a long-running poll; swallow non-OK.
      if (!res.ok) return;
    } catch {
      // best effort
    }
  },

  async stopLiveSession(
    baseUrl: string,
    auth: AuthContext,
    sessionName: string,
  ): Promise<void> {
    const url = `${baseUrl}/live/${sessionName}`;
    try {
      const res = await fetch(url, {
        headers: { ...auth.headers },
        method: 'DELETE',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to stop session');
      }
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, url);
      }

      throw error;
    }
  },

  async getLiveSession(
    baseUrl: string,
    auth: AuthContext,
    sessionName: string,
  ): Promise<LiveSession> {
    const url = `${baseUrl}/live/${sessionName}`;
    try {
      const res = await fetch(url, {
        headers: { ...auth.headers },
        method: 'GET',
      });
      if (!res.ok) {
        await this.handleApiError(res, 'Failed to get session status');
      }

      return await parseJsonResponse<LiveSession>(res, 'Failed to get session status');
    } catch (error) {
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw this.enhanceFetchError(error, url);
      }

      throw error;
    }
  },
};
