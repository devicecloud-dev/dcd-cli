import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';

import { getCliConfig, resetCliConfigCache } from '../../src/config/cli-config.js';
import {
  checkKekForEncryption,
  resolveKekPublicKey,
} from '../../src/utils/envelope.js';

/**
 * The KEK public key comes from the API the upload goes to (dcd#1138): its
 * `GET /cli-config` publishes the newest KEK it holds the private half of, so
 * a rotation is an env change on the API and never a CLI release. Encrypting
 * for a key the receiving API cannot unwrap produces uploads it can't decrypt,
 * which is why there is no fallback to a compiled-in key any more.
 */
describe('KEK public key from /cli-config', () => {
  const ORIGINAL_OVERRIDE = process.env.DCD_BINARY_KEK_PUBLIC;
  const realFetch = globalThis.fetch;
  let requested: string[];

  function rawPublicKey(): string {
    const { publicKey } = generateKeyPairSync('x25519');
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  }

  function stubFetch(respond: (url: string) => Response | Promise<Response>): void {
    requested = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return respond(String(input));
    }) as typeof fetch;
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    delete process.env.DCD_BINARY_KEK_PUBLIC;
    resetCliConfigCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetCliConfigCache();
    if (ORIGINAL_OVERRIDE === undefined) delete process.env.DCD_BINARY_KEK_PUBLIC;
    else process.env.DCD_BINARY_KEK_PUBLIC = ORIGINAL_OVERRIDE;
  });

  describe('resolveKekPublicKey', () => {
    it('uses the key the API publishes, for any API URL', async () => {
      const key = rawPublicKey();
      stubFetch(() => json({ binary_kek_public_key: { version: 2, key } }));

      const kek = await resolveKekPublicKey('https://my-proxy.corp.test/devicecloud');
      expect(kek?.version).to.equal(2);
      expect(kek?.keyRaw.toString('base64')).to.equal(key);
      expect(requested).to.deep.equal(['https://my-proxy.corp.test/devicecloud/cli-config']);
    });

    it('fetches the config once per process and shares it with the Supabase key', async () => {
      const key = rawPublicKey();
      stubFetch(() =>
        json({ supabase_publishable_key: 'sb_publishable_x', binary_kek_public_key: { version: 1, key } }),
      );

      await resolveKekPublicKey('https://api.devicecloud.dev/');
      await resolveKekPublicKey('https://api.devicecloud.dev');
      expect((await getCliConfig('https://api.devicecloud.dev')).supabase_publishable_key).to.equal(
        'sb_publishable_x',
      );
      expect(requested).to.deep.equal(['https://api.devicecloud.dev/cli-config']);
    });

    it('has no key when the API publishes none', async () => {
      stubFetch(() => json({ supabase_publishable_key: 'sb_publishable_x' }));
      expect(await resolveKekPublicKey('https://api.example.com')).to.equal(null);
    });

    it('rejects a malformed published key rather than wrapping with it', async () => {
      stubFetch(() => json({ binary_kek_public_key: { version: 1, key: 'not-32-bytes' } }));
      let message = '';
      try {
        await resolveKekPublicKey('https://api.example.com');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).to.contain('malformed binary_kek_public_key');
    });

    it('fails, and does not cache the failure, when the API cannot be asked', async () => {
      stubFetch(() => json({}, 503));
      let failed = false;
      try {
        await resolveKekPublicKey('https://api.example.com');
      } catch {
        failed = true;
      }
      expect(failed).to.equal(true);

      const key = rawPublicKey();
      stubFetch(() => json({ binary_kek_public_key: { version: 1, key } }));
      expect((await resolveKekPublicKey('https://api.example.com'))?.version).to.equal(1);
    });

    it('prefers DCD_BINARY_KEK_PUBLIC without asking the API', async () => {
      process.env.DCD_BINARY_KEK_PUBLIC = `7:${rawPublicKey()}`;
      stubFetch(() => json({ binary_kek_public_key: { version: 1, key: rawPublicKey() } }));

      expect((await resolveKekPublicKey('https://api.example.com'))?.version).to.equal(7);
      expect(requested).to.deep.equal([]);
    });

    it('rejects a malformed DCD_BINARY_KEK_PUBLIC', async () => {
      process.env.DCD_BINARY_KEK_PUBLIC = 'nope';
      let message = '';
      try {
        await resolveKekPublicKey('https://api.example.com');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).to.contain('DCD_BINARY_KEK_PUBLIC must be');
    });
  });

  describe('checkKekForEncryption', () => {
    const NO_KEK = 'https://api.example.com';

    it('passes a decision through when the API publishes a key', async () => {
      stubFetch(() => json({ binary_kek_public_key: { version: 1, key: rawPublicKey() } }));
      for (const source of ['flag', 'env', 'server'] as const) {
        expect(
          await checkKekForEncryption({ enabled: true, source }, 'https://api.dev.devicecloud.dev'),
        ).to.deep.equal({ enabled: true, source });
      }
    });

    it('passes a decision to stay off through without asking the API', async () => {
      stubFetch(() => json({}, 500));
      expect(await checkKekForEncryption({ enabled: false, source: 'off' }, NO_KEK)).to.deep.equal({
        enabled: false,
        source: 'off',
      });
      expect(requested).to.deep.equal([]);
    });

    for (const source of ['env', 'server'] as const) {
      it(`skips ${source} encryption when the API publishes no key, with a notice`, async () => {
        stubFetch(() => json({ supabase_publishable_key: 'sb_publishable_x' }));
        const decision = await checkKekForEncryption({ enabled: true, source }, NO_KEK);
        expect(decision).to.include({ enabled: false, source });
        expect(decision.notice).to.contain(NO_KEK);
        expect(decision.notice).to.contain('DCD_BINARY_KEK_PUBLIC');
        expect(decision.notice).to.not.contain('\n');
      });
    }

    it('refuses an explicit --encrypt when the API publishes no key', async () => {
      stubFetch(() => json({ supabase_publishable_key: 'sb_publishable_x' }));
      let message = '';
      try {
        await checkKekForEncryption({ enabled: true, source: 'flag' }, NO_KEK);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).to.match(/--encrypt needs the KEK public key.*DCD_BINARY_KEK_PUBLIC/);
    });

    it('fails closed rather than uploading plaintext when the API cannot be asked', async () => {
      stubFetch(() => json({}, 503));
      for (const source of ['flag', 'env', 'server'] as const) {
        let failed = false;
        try {
          await checkKekForEncryption({ enabled: true, source }, NO_KEK);
        } catch {
          failed = true;
        }
        expect(failed, source).to.equal(true);
      }
    });

    it('lets DCD_BINARY_KEK_PUBLIC unlock any API, whatever the source', async () => {
      process.env.DCD_BINARY_KEK_PUBLIC = `7:${rawPublicKey()}`;
      stubFetch(() => json({}, 500));
      for (const source of ['flag', 'env', 'server'] as const) {
        expect(await checkKekForEncryption({ enabled: true, source }, NO_KEK)).to.deep.equal({
          enabled: true,
          source,
        });
      }
      expect(requested).to.deep.equal([]);
    });
  });
});
