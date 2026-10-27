import { expect } from 'chai';

import { openBrowser, startOpener } from '../../src/utils/browser.js';

describe('openBrowser', () => {
  it('opens nothing that is not an http(s) URL', async () => {
    expect(await openBrowser('file:///etc/passwd')).to.equal(false);
    expect(await openBrowser('--help')).to.equal(false);
    expect(await openBrowser('not a url')).to.equal(false);
  });

  it('returns false, rather than crashing, when the opener is not installed', async () => {
    // As with xdg-open on a headless box: spawn emits ENOENT as an event.
    expect(await startOpener('dcd-test-no-such-opener', ['https://example.com'])).to.equal(false);
  });
});
