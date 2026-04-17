import { execSync } from 'node:child_process';

import { CompatibilityData } from '../utils/compatibility';

/**
 * Service for handling version validation and checking
 */
export class VersionService {
  /**
   * Check npm registry for the latest published version of the CLI
   * @returns Latest version string or null if check fails
   */
  async checkLatestCliVersion(): Promise<null | string> {
    try {
      const latestVersion = execSync('npm view @devicecloud.dev/dcd version', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      return latestVersion;
    } catch {
      // Silently fail - version check is informational only
      return null;
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
