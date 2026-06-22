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
