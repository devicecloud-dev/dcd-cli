import { expect } from 'chai';

import {
  type EncryptionDecision,
  resolveEncryption,
} from '../../src/utils/envelope.js';

/**
 * The order that decides whether a run encrypts (dcd#1138): an explicit flag,
 * then DCD_ENCRYPT (or its legacy alias), then the org's default from the
 * compatibility data, then off. Every case passes `env` explicitly so the
 * developer's own shell can't leak in.
 */
describe('resolveEncryption', () => {
  const on = (source: EncryptionDecision['source']) => ({ enabled: true, source });
  const off = (source: EncryptionDecision['source']) => ({ enabled: false, source });

  it('is off when nothing is set', () => {
    expect(resolveEncryption({ env: {} })).to.deep.equal(off('off'));
  });

  it('treats a missing server field (an older API) as off', () => {
    expect(resolveEncryption({ env: {}, serverDefault: undefined })).to.deep.equal(
      off('off'),
    );
  });

  it('is off when the server default is explicitly off', () => {
    expect(resolveEncryption({ env: {}, serverDefault: false })).to.deep.equal(
      off('off'),
    );
  });

  it('follows the server default when neither the flag nor the env decides', () => {
    expect(resolveEncryption({ env: {}, serverDefault: true })).to.deep.equal(
      on('server'),
    );
  });

  describe('an explicit flag', () => {
    it('--encrypt turns it on with nothing else set', () => {
      expect(resolveEncryption({ env: {}, flag: true })).to.deep.equal(on('flag'));
    });

    it('--no-encrypt beats DCD_ENCRYPT=1', () => {
      expect(
        resolveEncryption({ env: { DCD_ENCRYPT: '1' }, flag: false }),
      ).to.deep.equal(off('flag'));
    });

    it('--no-encrypt beats the server default', () => {
      expect(
        resolveEncryption({ env: {}, flag: false, serverDefault: true }),
      ).to.deep.equal(off('flag'));
    });

    it('--encrypt beats DCD_ENCRYPT=0', () => {
      expect(
        resolveEncryption({ env: { DCD_ENCRYPT: '0' }, flag: true }),
      ).to.deep.equal(on('flag'));
    });
  });

  describe('the env var', () => {
    for (const value of ['1', 'true', 'TRUE', 'True', ' 1 ']) {
      it(`reads DCD_ENCRYPT=${JSON.stringify(value)} as on`, () => {
        expect(resolveEncryption({ env: { DCD_ENCRYPT: value } })).to.deep.equal(
          on('env'),
        );
      });
    }

    for (const value of ['0', 'false', 'FALSE', 'False']) {
      it(`reads DCD_ENCRYPT=${JSON.stringify(value)} as off, beating the server default`, () => {
        expect(
          resolveEncryption({ env: { DCD_ENCRYPT: value }, serverDefault: true }),
        ).to.deep.equal(off('env'));
      });
    }

    for (const value of ['', 'yes', 'on', '2']) {
      it(`ignores DCD_ENCRYPT=${JSON.stringify(value)}, leaving the server default to decide`, () => {
        expect(
          resolveEncryption({ env: { DCD_ENCRYPT: value }, serverDefault: true }),
        ).to.deep.equal(on('server'));
        expect(resolveEncryption({ env: { DCD_ENCRYPT: value } })).to.deep.equal(
          off('off'),
        );
      });
    }

    it('honours the legacy DCD_ENCRYPT_BINARIES alias both ways', () => {
      expect(
        resolveEncryption({ env: { DCD_ENCRYPT_BINARIES: '1' } }),
      ).to.deep.equal(on('env'));
      expect(
        resolveEncryption({
          env: { DCD_ENCRYPT_BINARIES: 'false' },
          serverDefault: true,
        }),
      ).to.deep.equal(off('env'));
    });

    it('lets DCD_ENCRYPT win when both are set', () => {
      expect(
        resolveEncryption({
          env: { DCD_ENCRYPT: '0', DCD_ENCRYPT_BINARIES: '1' },
        }),
      ).to.deep.equal(off('env'));
      expect(
        resolveEncryption({
          env: { DCD_ENCRYPT: 'true', DCD_ENCRYPT_BINARIES: '0' },
        }),
      ).to.deep.equal(on('env'));
    });

    it('falls back to the alias when DCD_ENCRYPT is set to something unreadable', () => {
      expect(
        resolveEncryption({
          env: { DCD_ENCRYPT: 'yes', DCD_ENCRYPT_BINARIES: '1' },
        }),
      ).to.deep.equal(on('env'));
    });
  });

  it('reads process.env when no env is passed', () => {
    const original = process.env.DCD_ENCRYPT;
    try {
      process.env.DCD_ENCRYPT = '1';
      expect(resolveEncryption({})).to.deep.equal(on('env'));
    } finally {
      if (original === undefined) delete process.env.DCD_ENCRYPT;
      else process.env.DCD_ENCRYPT = original;
    }
  });

  describe('full matrix', () => {
    const flags = [undefined, true, false] as const;
    const envs: Array<[string, Record<string, string>, boolean | undefined]> = [
      ['unset', {}, undefined],
      ['DCD_ENCRYPT=1', { DCD_ENCRYPT: '1' }, true],
      ['DCD_ENCRYPT=0', { DCD_ENCRYPT: '0' }, false],
    ];
    const serverDefaults = [undefined, true, false] as const;

    for (const flag of flags) {
      for (const [envLabel, env, envValue] of envs) {
        for (const serverDefault of serverDefaults) {
          const expected: EncryptionDecision =
            flag !== undefined
              ? { enabled: flag, source: 'flag' }
              : envValue !== undefined
                ? { enabled: envValue, source: 'env' }
                : serverDefault === true
                  ? on('server')
                  : off('off');

          it(`flag=${String(flag)}, ${envLabel}, server=${String(serverDefault)} → ${expected.enabled ? 'on' : 'off'} (${expected.source})`, () => {
            expect(resolveEncryption({ env, flag, serverDefault })).to.deep.equal(
              expected,
            );
          });
        }
      }
    }
  });
});
