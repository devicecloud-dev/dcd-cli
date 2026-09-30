import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';

import {
  inferEnvFromApiUrl,
  kekEnvForApiUrl,
} from '../../src/config/environments.js';
import {
  checkKekForEncryption,
  resolveKekPublicKey,
} from '../../src/utils/envelope.js';

/**
 * A pinned KEK only applies to the API it belongs to (dcd#1138). Encrypting
 * for the prod KEK against any other URL, which inferEnvFromApiUrl's prod
 * fallback used to do, produces uploads that API can't decrypt.
 */
describe('KEK pinning by API URL', () => {
  const ORIGINAL_OVERRIDE = process.env.DCD_BINARY_KEK_PUBLIC;

  beforeEach(() => {
    delete process.env.DCD_BINARY_KEK_PUBLIC;
  });

  afterEach(() => {
    if (ORIGINAL_OVERRIDE === undefined) delete process.env.DCD_BINARY_KEK_PUBLIC;
    else process.env.DCD_BINARY_KEK_PUBLIC = ORIGINAL_OVERRIDE;
  });

  function setTestKek() {
    const { publicKey } = generateKeyPairSync('x25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    process.env.DCD_BINARY_KEK_PUBLIC = `7:${raw.toString('base64')}`;
  }

  describe('kekEnvForApiUrl', () => {
    const known: Array<[string, 'dev' | 'prod']> = [
      ['https://api.devicecloud.dev', 'prod'],
      ['https://api.devicecloud.dev/', 'prod'],
      ['https://api.dev.devicecloud.dev', 'dev'],
      ['https://api.dev.devicecloud.dev/', 'dev'],
      ['http://localhost:3000', 'dev'],
      ['http://localhost', 'dev'],
    ];
    for (const [url, env] of known) {
      it(`maps ${url} to ${env}`, () => {
        expect(kekEnvForApiUrl(url)).to.equal(env);
      });
    }

    const unknown = [
      'https://api.example.com',
      // inferEnvFromApiUrl reads any `api.dev.` host as dev.
      'https://api.dev.example.com',
      'https://devicecloud.dev.attacker.test',
      'http://127.0.0.1:3000',
      'https://my-proxy.corp.test/devicecloud',
      'not a url',
    ];
    for (const url of unknown) {
      it(`does not know ${url}`, () => {
        expect(kekEnvForApiUrl(url)).to.equal(undefined);
      });
    }

    it('leaves inferEnvFromApiUrl falling back to prod for its other callers', () => {
      expect(inferEnvFromApiUrl('https://api.example.com')).to.equal('prod');
      expect(inferEnvFromApiUrl('https://api.dev.example.com')).to.equal('dev');
    });
  });

  describe('resolveKekPublicKey', () => {
    it('has no key for an unknown API URL', () => {
      expect(resolveKekPublicKey('https://api.example.com')).to.equal(null);
    });

    it('uses DCD_BINARY_KEK_PUBLIC for any URL, known or not', () => {
      setTestKek();
      expect(resolveKekPublicKey('https://api.example.com')?.version).to.equal(7);
      expect(resolveKekPublicKey('https://api.devicecloud.dev')?.version).to.equal(7);
    });
  });

  describe('checkKekForEncryption', () => {
    const UNKNOWN = 'https://api.example.com';

    it('passes a decision through for a known API URL', () => {
      for (const source of ['flag', 'env', 'server'] as const) {
        expect(
          checkKekForEncryption({ enabled: true, source }, 'https://api.dev.devicecloud.dev'),
        ).to.deep.equal({ enabled: true, source });
      }
    });

    it('passes a decision to stay off through, whatever the URL', () => {
      expect(checkKekForEncryption({ enabled: false, source: 'off' }, UNKNOWN)).to.deep.equal({
        enabled: false,
        source: 'off',
      });
    });

    for (const source of ['env', 'server'] as const) {
      it(`skips ${source} encryption on an unknown URL, with a notice`, () => {
        const decision = checkKekForEncryption({ enabled: true, source }, UNKNOWN);
        expect(decision).to.include({ enabled: false, source });
        expect(decision.notice).to.contain(UNKNOWN);
        expect(decision.notice).to.contain('DCD_BINARY_KEK_PUBLIC');
        expect(decision.notice).to.not.contain('\n');
      });
    }

    it('refuses an explicit --encrypt on an unknown URL', () => {
      expect(() =>
        checkKekForEncryption({ enabled: true, source: 'flag' }, UNKNOWN),
      ).to.throw(/--encrypt needs the KEK public key.*DCD_BINARY_KEK_PUBLIC/);
    });

    it('lets DCD_BINARY_KEK_PUBLIC unlock an unknown URL, whatever the source', () => {
      setTestKek();
      for (const source of ['flag', 'env', 'server'] as const) {
        expect(checkKekForEncryption({ enabled: true, source }, UNKNOWN)).to.deep.equal({
          enabled: true,
          source,
        });
      }
    });
  });
});
