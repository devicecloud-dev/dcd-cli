import { expect } from 'chai';

import { parseResultFilter } from '../../src/commands/artifacts.js';

describe('dcd artifacts --result-id / --flow', () => {
  it('passes nothing through when neither is given', () => {
    expect(parseResultFilter(undefined, undefined, true)).to.equal(undefined);
    expect(parseResultFilter(undefined, undefined, false)).to.equal(undefined);
  });

  it('parses a result id', () => {
    expect(parseResultFilter('4446290', undefined, true)).to.equal(4446290);
  });

  it('leaves a flow for the service to resolve', () => {
    expect(parseResultFilter(undefined, 'login', true)).to.equal(undefined);
  });

  for (const bad of ['0', '-3', '1.5', 'abc', '12abc', '', '9007199254740993']) {
    it(`rejects --result-id '${bad}'`, () => {
      expect(() => parseResultFilter(bad, undefined, true)).to.throw(
        /--result-id must be a positive whole number/,
      );
    });
  }

  it('rejects both at once', () => {
    expect(() => parseResultFilter('1', 'login', true)).to.throw(/mutually exclusive/);
  });

  it('needs --download-artifacts', () => {
    expect(() => parseResultFilter('1', undefined, false)).to.throw(
      '--result-id requires --download-artifacts.',
    );
    expect(() => parseResultFilter(undefined, 'login', false)).to.throw(
      '--flow requires --download-artifacts.',
    );
  });

  it('rejects an empty --flow', () => {
    expect(() => parseResultFilter(undefined, '  ', true)).to.throw(/--flow needs/);
  });
});
