import type { AuthContext } from '../types/domain/auth.types.js';
import type { Notice } from '../services/notices.service.js';

export interface CompatibilityData {
  android: Record<string, string[]>;
  androidPlay: Record<string, string[]>;
  ios: Record<string, string[]>;
  maestro: {
    defaultVersion: string;
    latestVersion: string;
    supportedVersions: string[];
  };
  /** Active CLI notices, piggybacked onto the compatibility response by the API. */
  notices?: Notice[];
}

/** Identity the CLI forwards so the API can target notices by version / CI. */
export interface ClientContext {
  cliVersion?: string;
  ciProvider?: string | null;
  ciWrapperVersion?: string | null;
}

let cachedCompatibilityData: CompatibilityData | null = null;

export async function fetchCompatibilityData(
  apiUrl: string,
  auth: AuthContext,
  clientContext?: ClientContext,
): Promise<CompatibilityData> {
  if (cachedCompatibilityData) {
    return cachedCompatibilityData;
  }

  // Forward CLI / CI identity so the API can version-filter and target notices.
  const noticeHeaders: Record<string, string> = {};
  if (clientContext?.cliVersion) {
    noticeHeaders['x-dcd-cli-version'] = clientContext.cliVersion;
  }
  if (clientContext?.ciProvider) {
    noticeHeaders['x-dcd-ci-provider'] = clientContext.ciProvider;
  }
  if (clientContext?.ciWrapperVersion) {
    noticeHeaders['x-dcd-ci-wrapper-version'] = clientContext.ciWrapperVersion;
  }

  try {
    const response = await fetch(`${apiUrl}/results/compatibility/data`, {
      headers: {
        'Content-Type': 'application/json',
        ...auth.headers,
        ...noticeHeaders,
      },
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json() as { data?: CompatibilityData; message?: string; statusCode: number };
    
    if (result.statusCode !== 200 || !result.data) {
      throw new Error(result.message || 'Failed to fetch compatibility data');
    }

    cachedCompatibilityData = result.data;
    return result.data;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch compatibility data from API: ${errorMessage}`, {
      cause: error,
    });
  }
}

export function clearCompatibilityCache() {
  cachedCompatibilityData = null;
}