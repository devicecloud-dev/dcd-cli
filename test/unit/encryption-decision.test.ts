import { expect } from 'chai';

import { resolveEncryption } from '../../src/utils/envelope.js';

/**
 * Uploads are always encrypted (dcd#1138). The old opt-outs, --no-encrypt and
 * DCD_ENCRYPT=0 (or its legacy alias), are ignored with a warning. Every case
 * passes `env` explicitly so the developer's own shell can't leak in.
 */
describe('resolveEncryption', () => {
  const ON = { enabled: true, source: 'always' };

  it('is on when nothing is set', () => {
    expect(resolveEncryption({ env: {} })).to.deep.equal(ON);
  });

  it('is on with --encrypt, which is now a no-op', () => {
    expect(resolveEncryption({ env: {}, flag: true })).to.deep.equal(ON);
  });

  it('is on with DCD_ENCRYPT=1', () => {
    expect(resolveEncryption({ env: { DCD_ENCRYPT: '1' } })).to.deep.equal(ON);
  });

  it('ignores --no-encrypt, and says so', () => {
    expect(resolveEncryption({ env: {}, flag: false })).to.deep.equal({
      ...ON,
      notice: 'Ignoring --no-encrypt: uploads are always encrypted.',
    });
  });

  for (const value of ['0', 'false', 'FALSE', 'False', ' 0 ']) {
    it(`ignores DCD_ENCRYPT=${JSON.stringify(value)}, and says so`, () => {
      expect(resolveEncryption({ env: { DCD_ENCRYPT: value } })).to.deep.equal({
        ...ON,
        notice: 'Ignoring DCD_ENCRYPT: uploads are always encrypted.',
      });
    });
  }

  it('ignores the legacy DCD_ENCRYPT_BINARIES=0, and says so', () => {
    expect(resolveEncryption({ env: { DCD_ENCRYPT_BINARIES: '0' } })).to.deep.equal({
      ...ON,
      notice: 'Ignoring DCD_ENCRYPT_BINARIES: uploads are always encrypted.',
    });
  });

  it('names every ignored opt-out in one line', () => {
    expect(
      resolveEncryption({
        env: { DCD_ENCRYPT: '0', DCD_ENCRYPT_BINARIES: 'false' },
        flag: false,
      }),
    ).to.deep.equal({
      ...ON,
      notice:
        'Ignoring --no-encrypt and DCD_ENCRYPT and DCD_ENCRYPT_BINARIES: uploads are always encrypted.',
    });
  });

  for (const value of ['', 'yes', 'on', '2', '1', 'true']) {
    it(`gives no notice for DCD_ENCRYPT=${JSON.stringify(value)}`, () => {
      expect(resolveEncryption({ env: { DCD_ENCRYPT: value } })).to.deep.equal(ON);
    });
  }

  it('reads process.env when no env is passed', () => {
    const original = process.env.DCD_ENCRYPT;
    try {
      process.env.DCD_ENCRYPT = '0';
      expect(resolveEncryption().notice).to.equal(
        'Ignoring DCD_ENCRYPT: uploads are always encrypted.',
      );
    } finally {
      if (original === undefined) delete process.env.DCD_ENCRYPT;
      else process.env.DCD_ENCRYPT = original;
    }
  });
});
