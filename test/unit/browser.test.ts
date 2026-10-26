import { expect } from 'chai';

import { openBrowser } from '../../src/utils/browser.js';

describe('openBrowser', () => {
  it('opens nothing that is not an http(s) URL', () => {
    expect(openBrowser('file:///etc/passwd')).to.equal(false);
    expect(openBrowser('--help')).to.equal(false);
    expect(openBrowser('not a url')).to.equal(false);
  });
});
