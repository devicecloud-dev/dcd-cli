import { expect } from 'chai';

import { CliError } from '../../src/utils/cli.js';
import {
  assertMatrixSupported,
  matrixIsIos,
  parseDeviceMatrix,
} from '../../src/utils/device-matrix.js';

/**
 * The device matrix is the load-bearing part of #1105: each --ios-device-matrix /
 * --android-device-matrix names exactly one cell, there is no cross-product, and a
 * matrix is single-platform. These are pure and worth pinning precisely.
 */
describe('parseDeviceMatrix', () => {
  it('returns an empty matrix when no config flags are passed', () => {
    expect(parseDeviceMatrix([], [])).to.deep.equal([]);
    expect(matrixIsIos([])).to.equal(false);
  });

  it('parses each --ios-device-matrix as exactly one cell (no cross-product)', () => {
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

  it('parses --android-device-matrix, with :play marking a Google Play cell', () => {
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

/**
 * An API that predates the matrix silently STRIPS the unknown deviceMatrix
 * field (its ValidationPipe is whitelist:true / forbidNonWhitelisted:false) and
 * runs every flow on one default device, exiting 0. Submitting into that is the
 * worst outcome the feature can produce, so it must be refused, not tolerated.
 */
describe('assertMatrixSupported', () => {
  const matrix = [{ iOSDevice: 'iphone-16', iOSVersion: '18' }];

  it('throws when a matrix was requested but the API has no estimate endpoint', () => {
    expect(() => assertMatrixSupported(matrix, null)).to.throw(
      CliError,
      /does not support device matrices/i,
    );
  });

  it('explains that submitting anyway would silently run a single device', () => {
    expect(() => assertMatrixSupported(matrix, null)).to.throw(
      /silently run every flow on a single default device/i,
    );
  });

  it('passes when the API returned an estimate', () => {
    expect(() =>
      assertMatrixSupported(matrix, { cellCount: 2, totalCost: 0.16 }),
    ).to.not.throw();
  });

  it('is a no-op when no matrix was requested (legacy single-device runs)', () => {
    expect(() => assertMatrixSupported([], null)).to.not.throw();
  });
});
