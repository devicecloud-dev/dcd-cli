import { CompatibilityData } from '../utils/compatibility.js';

const DEFAULT_MANIFEST_URL = 'https://get.devicecloud.dev/latest.json';
const MANIFEST_TIMEOUT_MS = 3000;

/**
 * Compare two semantic versions per SemVer 2.0.0 precedence rules.
 * Returns a negative number if `a < b`, positive if `a > b`, and 0 if equal.
 *
 * Implements the prerelease rules that the previous naive comparator dropped:
 *   - A version WITH a prerelease has lower precedence than the same version
 *     without one ("1.0.0-beta" < "1.0.0").
 *   - Prerelease identifiers are compared dot-separated, left to right:
 *     numeric identifiers compare numerically, alphanumeric ones compare
 *     lexically (ASCII), and numeric always sorts below alphanumeric. A longer
 *     set of identifiers wins when all preceding ones are equal.
 */
function compareSemver(a: string, b: string): number {
  const split = (v: string): { release: number[]; pre: string[] } => {
    const [core, ...preParts] = v.trim().replace(/^v/, '').split('-');
    const nums = core.split('.').map((n) => Number(n) || 0);
    const pre = preParts.join('-');
    return {
      release: [nums[0] || 0, nums[1] || 0, nums[2] || 0],
      pre: pre ? pre.split('.') : [],
    };
  };

  const left = split(a);
  const right = split(b);

  for (let i = 0; i < 3; i++) {
    if (left.release[i] !== right.release[i]) {
      return left.release[i] - right.release[i];
    }
  }

  // Equal release: a version with no prerelease outranks one that has it.
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;

  const len = Math.min(left.pre.length, right.pre.length);
  for (let i = 0; i < len; i++) {
    const lp = left.pre[i];
    const rp = right.pre[i];
    if (lp === rp) continue;
    const ln = /^\d+$/.test(lp);
    const rn = /^\d+$/.test(rp);
    if (ln && rn) return Number(lp) - Number(rp);
    if (ln) return -1; // numeric identifiers sort below alphanumeric
    if (rn) return 1;
    return lp < rp ? -1 : 1;
  }
  return left.pre.length - right.pre.length;
}

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
   * Compare two semantic version strings (SemVer 2.0.0 precedence, including
   * prerelease tags). Returns true if `current` is strictly older than `latest`.
   *
   * Prerelease handling matters here: a beta-to-beta bump such as
   * "5.0.0-beta.0" -> "5.0.0-beta.1" shares the same major.minor.patch, so we
   * must compare the prerelease identifiers to detect that an upgrade exists.
   */
  isOutdated(current: string, latest: string): boolean {
    return compareSemver(current, latest) < 0;
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

    if (!resolvedVersion) {
      throw new Error(
        'Unable to resolve a Maestro version: compatibility data did not provide a default.',
      );
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
