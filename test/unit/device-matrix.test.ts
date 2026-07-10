import { expect } from 'chai';

import { CliError } from '../../src/utils/cli.js';
import {
  matrixIsIos,
  parseDeviceMatrix,
} from '../../src/utils/device-matrix.js';

/**
 * The device matrix is the load-bearing part of #1105: each --ios-config /
 * --android-config names exactly one cell, there is no cross-product, and a
 * matrix is single-platform. These are pure and worth pinning precisely.
 */
describe('parseDeviceMatrix', () => {
  it('returns an empty matrix when no config flags are passed', () => {
    expect(parseDeviceMatrix([], [])).to.deep.equal([]);
    expect(matrixIsIos([])).to.equal(false);
  });

  it('parses each --ios-config as exactly one cell (no cross-product)', () => {
    const matrix = parseDeviceMatrix(
      ['iphone-16:18', 'iphone-16-pro:26'],
      [],
    );
    expect(matrix).to.deep.equal([
      { iOSDevice: 'iphone-16', iOSVersion: '18' },
      { iOSDevice: 'iphone-16-pro', iOSVersion: '26' },
    ]);
    expect(matrixIsIos(matrix)).to.equal(true);
  });

  it('parses --android-config, with :play marking a Google Play cell', () => {
    expect(parseDeviceMatrix([], ['pixel-7:34', 'pixel-7:34:play'])).to.deep.equal([
      { androidDevice: 'pixel-7', androidApiLevel: '34' },
      { androidDevice: 'pixel-7', androidApiLevel: '34', googlePlay: true },
    ]);
  });

  it('rejects a mixed-platform matrix', () => {
    expect(() =>
      parseDeviceMatrix(['iphone-16:18'], ['pixel-7:34']),
    ).to.throw(CliError, /cannot mix platforms/i);
  });

  it('rejects malformed iOS syntax, naming the offending value', () => {
    expect(() => parseDeviceMatrix(['iphone-16'], [])).to.throw(
      CliError,
      /iphone-16/,
    );
    expect(() => parseDeviceMatrix(['iphone-16:'], [])).to.throw(CliError);
    expect(() => parseDeviceMatrix([':18'], [])).to.throw(CliError);
  });

  it('rejects malformed Android syntax and a bad third segment', () => {
    expect(() => parseDeviceMatrix([], ['pixel-7'])).to.throw(CliError);
    expect(() => parseDeviceMatrix([], ['pixel-7:34:store'])).to.throw(
      CliError,
      /pixel-7:34:store/,
    );
  });
});
