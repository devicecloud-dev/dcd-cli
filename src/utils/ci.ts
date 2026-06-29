/**
 * Best-effort detection of non-interactive / CI environments. Used to suppress
 * interactive niceties (e.g. the `dcd login` nudge) that only make sense for a
 * human at a terminal. Dependency-free on purpose — these are the env vars the
 * major providers set, plus a TTY check for piped/redirected output.
 */

// Generic + per-provider markers. `CI` is set by virtually every provider;
// the rest cover platforms that historically didn't set it.
const CI_ENV_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_NUMBER',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'DRONE',
  'TEAMCITY_VERSION',
  'TF_BUILD', // Azure Pipelines
  'JENKINS_URL',
  'BITBUCKET_BUILD_NUMBER',
  'APPVEYOR',
  'CODEBUILD_BUILD_ID',
] as const;

/**
 * Returns true when running under CI or otherwise non-interactively (no TTY on
 * stdout, e.g. output piped to a file). A truthy value for any known CI env var
 * counts — providers set `CI=true`, but a bare presence check is the safe net.
 */
export function isCI(): boolean {
  for (const name of CI_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined && value !== '' && value !== 'false' && value !== '0') {
      return true;
    }
  }

  return !process.stdout.isTTY;
}

/** Which DCD CI integration (if any) is wrapping this CLI invocation, and its version. */
export interface CiContext {
  /** e.g. 'github' | 'bitrise' | 'bitbucket' | 'eas' | 'gitlab' | 'circleci'. */
  provider: string | null;
  /** The wrapper's own version, if it forwarded one (DCD_CI_WRAPPER_VERSION). */
  wrapperVersion: string | null;
}

/** Infer the CI provider from the env vars each platform sets natively. */
function inferProvider(): string | null {
  const env = process.env;
  if (env.GITHUB_ACTIONS) return 'github';
  if (env.BITRISE_IO || env.BITRISE_BUILD_NUMBER) return 'bitrise';
  if (env.BITBUCKET_BUILD_NUMBER) return 'bitbucket';
  if (env.EAS_BUILD || env.EAS_BUILD_RUNNER || env.EAS_BUILD_ID) return 'eas';
  if (env.GITLAB_CI) return 'gitlab';
  if (env.CIRCLECI) return 'circleci';
  return null;
}

/**
 * Resolve the CI integration context the CLI forwards to the notices API so
 * notices can target a specific integration/version (e.g. "Bitbucket Pipe <
 * 1.1.0"). The DCD CI wrappers set `DCD_CI_PROVIDER` / `DCD_CI_WRAPPER_VERSION`
 * explicitly (preferred — carries the wrapper version); otherwise the provider
 * is inferred from native env vars and the version is unknown.
 */
export function detectCiContext(): CiContext {
  const forwardedProvider = process.env.DCD_CI_PROVIDER?.trim();
  const forwardedVersion = process.env.DCD_CI_WRAPPER_VERSION?.trim();
  return {
    provider: forwardedProvider || inferProvider(),
    wrapperVersion: forwardedVersion || null,
  };
}
