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

  function stubFetch(respond: (url: string) => Response | Promise<Response>): void {
    requested = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      return respond(url);
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

  /**
   * Supabase Auth refuses a refresh with a 4xx and an error code: in `code`
   * when the response is versioned (2024-01-01 and later), in `error_code`
   * before that. The CLI names the common causes instead of echoing them.
   */
  describe('when Supabase refuses the refresh', () => {
    const storedSession = {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: 0,
      user_email: 'u@example.com',
      user_id: 'u1',
    };

    function refuseRefresh(token: () => Response): void {
      stubFetch((url) =>
        url.endsWith('/cli-config')
          ? json({ supabase_publishable_key: 'sb_publishable_abc' })
          : token(),
      );
    }

    const versioned = (status: number, code: string, message: string) =>
      new Response(JSON.stringify({ code, message }), {
        status,
        headers: {
          'content-type': 'application/json',
          'x-supabase-api-version': '2024-01-01',
        },
      });

    async function refreshError(): Promise<SessionRefreshError> {
      try {
        await CliAuthGateway.refresh('https://cloud.devicecloud.dev', 'prod', storedSession);
      } catch (error) {
        expect(error).to.be.instanceOf(SessionRefreshError);
        return error as SessionRefreshError;
      }
      throw new Error('expected the refresh to fail');
    }

    it('says the session expired', async () => {
      refuseRefresh(() => versioned(403, 'session_expired', 'Invalid Refresh Token: Session Expired'));

      const error = await refreshError();

      expect(error.message).to.equal('Your session expired. Run `dcd login` to sign in again.');
      expect(error.code).to.equal('session_expired');
      expect(error.definitive).to.equal(true);
      expect(requested[1]).to.equal(
        'https://cloud.devicecloud.dev/auth/v1/token?grant_type=refresh_token',
      );
    });

    it('reads the code from an unversioned response too', async () => {
      refuseRefresh(() =>
        json(
          { code: 403, error_code: 'session_expired', msg: 'Invalid Refresh Token: Session Expired (Inactivity)' },
          403,
        ),
      );

      const error = await refreshError();

      expect(error.message).to.equal('Your session expired. Run `dcd login` to sign in again.');
      expect(error.code).to.equal('session_expired');
      expect(error.definitive).to.equal(true);
    });

    it('says the session was signed out when it no longer exists', async () => {
      for (const code of ['refresh_token_not_found', 'session_not_found']) {
        refuseRefresh(() => versioned(400, code, 'Invalid Refresh Token: Refresh Token Not Found'));

        const error = await refreshError();

        expect(error.message).to.equal(
          'Your session was signed out. Run `dcd login` to sign in again.',
        );
        expect(error.code).to.equal(code);
        expect(error.definitive).to.equal(true);
      }
    });

    it("keeps Supabase's message for any other refusal", async () => {
      refuseRefresh(() =>
        versioned(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used'),
      );

      const error = await refreshError();

      expect(error.message).to.equal(
        'Failed to refresh session: Invalid Refresh Token: Already Used. Run `dcd login` again.',
      );
      expect(error.code).to.equal('refresh_token_already_used');
      expect(error.definitive).to.equal(true);
    });
  });
});
