import { expect } from 'chai';

import {
  getSupabaseKey,
  resetSupabaseKeyCache,
  supabaseKeyHeaders,
} from '../../src/config/supabase-key.js';
import { CliAuthGateway, SessionRefreshError } from '../../src/gateways/cli-auth-gateway.js';

/**
 * The Supabase key is fetched from the API's `GET /cli-config` (dcd#1112)
 * rather than compiled in, so it can be rotated without a CLI release.
 */
describe('Supabase key from /cli-config', () => {
  const realFetch = globalThis.fetch;
  let requested: string[];

  function stubFetch(respond: () => Response | Promise<Response>): void {
    requested = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return respond();
    }) as typeof fetch;
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => resetSupabaseKeyCache());
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetSupabaseKeyCache();
  });

  it('fetches the key from the env API once per process', async () => {
    stubFetch(() => json({ supabase_publishable_key: 'sb_publishable_abc' }));

    expect(await getSupabaseKey('prod')).to.equal('sb_publishable_abc');
    expect(await getSupabaseKey('prod')).to.equal('sb_publishable_abc');
    expect(requested).to.deep.equal(['https://api.devicecloud.dev/cli-config']);
  });

  it('does not cache a failure, so the next call retries', async () => {
    stubFetch(() => json({}, 503));
    let failed = false;
    try {
      await getSupabaseKey('dev');
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);

    stubFetch(() => json({ supabase_publishable_key: 'sb_publishable_dev' }));
    expect(await getSupabaseKey('dev')).to.equal('sb_publishable_dev');
  });

  it('rejects a response with no key', async () => {
    stubFetch(() => json({ supabase_url: 'https://x.supabase.co' }));
    let message = '';
    try {
      await getSupabaseKey('prod');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).to.contain('no supabase_publishable_key');
  });

  it('sends a publishable key as apikey only, and a legacy JWT key as a Bearer too', () => {
    expect(supabaseKeyHeaders('sb_publishable_abc')).to.deep.equal({ apikey: 'sb_publishable_abc' });
    expect(supabaseKeyHeaders('eyJhbGciOi.x.y')).to.deep.equal({
      apikey: 'eyJhbGciOi.x.y',
      authorization: 'Bearer eyJhbGciOi.x.y',
    });
  });

  it('keeps the stored session when the key cannot be fetched during a refresh', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    let caught: unknown;
    try {
      await CliAuthGateway.refresh('https://cloud.devicecloud.dev', 'prod', {
        access_token: 'a',
        refresh_token: 'r',
        expires_at: 0,
        user_email: 'u@example.com',
        user_id: 'u1',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(SessionRefreshError);
    // Not definitive, so resolveAuth will not delete the user's login.
    expect((caught as SessionRefreshError).definitive).to.equal(false);
  });
});
