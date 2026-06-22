import type { AuthContext } from '../types/domain/auth.types';

export interface CompatibilityData {
  android: Record<string, string[]>;
  androidPlay: Record<string, string[]>;
  ios: Record<string, string[]>;
  maestro: {
    defaultVersion: string;
    latestVersion: string;
    supportedVersions: string[];
  };
}

let cachedCompatibilityData: CompatibilityData | null = null;

export async function fetchCompatibilityData(apiUrl: string, auth: AuthContext): Promise<CompatibilityData> {
  if (cachedCompatibilityData) {
    return cachedCompatibilityData;
  }

  try {
    const response = await fetch(`${apiUrl}/results/compatibility/data`, {
      headers: {
        'Content-Type': 'application/json',
        ...auth.headers,
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