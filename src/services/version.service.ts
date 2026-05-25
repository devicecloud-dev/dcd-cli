import { CompatibilityData } from '../utils/compatibility';

const DEFAULT_MANIFEST_URL = 'https://get.devicecloud.dev/latest.json';
const MANIFEST_TIMEOUT_MS = 3000;

/**
 * Service for handling version validation and checking
 */
export class VersionService {
  /**
   * Fetch the latest published CLI version from the release manifest.
   * Works for both npm- and binary-installed users (no `npm` shell-out).
   * Silently returns null on any failure — this check is informational only.
   */
  async checkLatestCliVersion(): Promise<null | string> {
    const url = process.env.DCD_MANIFEST_URL ?? DEFAULT_MANIFEST_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: unknown };
      return typeof data.version === 'string' ? data.version : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Compare two semantic version strings
   * @param current - Current version
   * @param latest - Latest version
   * @returns true if current is older than latest
   */
  isOutdated(current: string, latest: string): boolean {
    const currentParts = current.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      if (currentParts[i] < latestParts[i]) return true;
      if (currentParts[i] > latestParts[i]) return false;
    }

    return false;
  }

  /**
   * Resolve and validate Maestro version against API compatibility data
   * @param requestedVersion - Version requested by user (or undefined for default)
   * @param compatibilityData - API compatibility data
   * @param options - Configuration options
   * @param options.debug - Enable debug logging
   * @param options.logger - Optional logger function
   * @returns Validated Maestro version string
   * @throws Error if version is not supported
   */
  resolveMaestroVersion(
    requestedVersion: string | undefined,
    compatibilityData: CompatibilityData,
    options?: {
      debug?: boolean;
      logger?: (message: string) => void;
    },
  ): string {
    const { debug = false, logger } = options || {};
    const log = logger || console.log;

    const { supportedVersions, defaultVersion, latestVersion } =
      compatibilityData.maestro;

    // Resolve "latest" to actual latest version from API
    let resolvedVersion = requestedVersion;

    if (requestedVersion === 'latest') {
      resolvedVersion = latestVersion;
      if (debug) {
        log(`[DEBUG] Resolved "latest" to ${latestVersion}`);
      }
    } else if (!requestedVersion) {
      resolvedVersion = defaultVersion;
      if (debug) {
        log(`[DEBUG] Using default Maestro version ${defaultVersion}`);
      }
    }

    // Validate Maestro version
    if (!supportedVersions.includes(resolvedVersion)) {
      throw new Error(
        `Maestro version ${resolvedVersion} is not supported. Supported versions: ${supportedVersions.join(', ')}`,
      );
    }

    if (debug) {
      log(`[DEBUG] Maestro version validated: ${resolvedVersion}`);
      log(`[DEBUG] Supported Maestro versions: ${supportedVersions.join(', ')}`);
    }

    return resolvedVersion;
  }
}
