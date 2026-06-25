import { expect } from 'chai';

import { VersionService } from '../../src/services/version.service.js';

describe('VersionService.isOutdated', () => {
  const svc = new VersionService();

  it('detects a release-level upgrade', () => {
    expect(svc.isOutdated('5.0.0', '5.0.1')).to.equal(true);
    expect(svc.isOutdated('4.9.0', '5.0.0')).to.equal(true);
    expect(svc.isOutdated('5.1.0', '5.0.9')).to.equal(false);
  });

  it('detects a beta-to-beta prerelease upgrade', () => {
    // Regression: both reduce to 5.0.0 under a naive major.minor.patch compare.
    expect(svc.isOutdated('5.0.0-beta.0', '5.0.0-beta.1')).to.equal(true);
    expect(svc.isOutdated('5.0.0-beta.1', '5.0.0-beta.0')).to.equal(false);
    expect(svc.isOutdated('5.0.0-beta.10', '5.0.0-beta.2')).to.equal(false);
  });

  it('ranks a prerelease below its final release', () => {
    expect(svc.isOutdated('5.0.0-beta.1', '5.0.0')).to.equal(true);
    expect(svc.isOutdated('5.0.0', '5.0.0-beta.1')).to.equal(false);
  });

  it('returns false when versions are equal', () => {
    expect(svc.isOutdated('5.0.0', '5.0.0')).to.equal(false);
    expect(svc.isOutdated('5.0.0-beta.1', '5.0.0-beta.1')).to.equal(false);
  });

  it('tolerates a leading v and short versions', () => {
    expect(svc.isOutdated('v5.0.0', 'v5.0.1')).to.equal(true);
    expect(svc.isOutdated('5.0', '5.0.1')).to.equal(true);
  });
});
