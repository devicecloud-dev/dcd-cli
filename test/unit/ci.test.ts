import { expect } from 'chai';

import { isCI } from '../../src/utils/ci';

// Every env var isCI() inspects — cleared before each case so the environment
// the suite happens to run in (often a real CI) can't leak into assertions.
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
  'TF_BUILD',
  'JENKINS_URL',
  'BITBUCKET_BUILD_NUMBER',
  'APPVEYOR',
  'CODEBUILD_BUILD_ID',
];

describe('isCI', () => {
  const ORIGINAL_ENV = { ...process.env };
  const originalIsTTY = process.stdout.isTTY;

  const setTTY = (value: boolean | undefined) => {
    // isTTY is a plain (writable) property on the stream in Node.
    (process.stdout as { isTTY?: boolean }).isTTY = value;
  };

  beforeEach(() => {
    for (const name of CI_ENV_VARS) delete process.env[name];
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setTTY(originalIsTTY);
  });

  it('returns true when CI is set', () => {
    setTTY(true);
    process.env.CI = 'true';
    expect(isCI()).to.equal(true);
  });

  it('returns true for a provider var even when CI is unset', () => {
    setTTY(true);
    process.env.GITHUB_ACTIONS = 'true';
    expect(isCI()).to.equal(true);
  });

  it('treats CI=false / CI=0 as not CI (falls through to the TTY check)', () => {
    setTTY(true);
    process.env.CI = 'false';
    expect(isCI()).to.equal(false);
    process.env.CI = '0';
    expect(isCI()).to.equal(false);
  });

  it('returns false in an interactive (TTY), non-CI environment', () => {
    setTTY(true);
    expect(isCI()).to.equal(false);
  });

  it('returns true when stdout is not a TTY (piped/redirected)', () => {
    setTTY(false);
    expect(isCI()).to.equal(true);
  });
});
