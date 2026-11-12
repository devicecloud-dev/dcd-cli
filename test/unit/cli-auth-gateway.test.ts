import { expect } from 'chai';

import { CliAuthGateway, SessionRefreshError } from '../../src/gateways/cli-auth-gateway.js';

/**
 * A `dcd login` session is refreshed through the API's POST /cli-login/refresh,
 * not Supabase Auth, so the CLI needs no Supabase key for it. A refusal the
 * user can only fix with `dcd login` must be `definitive`; anything else must
 * leave the stored session alone for the next try.
 */
describe('CliAuthGateway.refresh', () => {
  const realFetch = globalThis.fetch;
  const stored = {
    access_token: 'a',
    refresh_token: 'r',
    expires_at: 0,
    user_email: 'u@example.com',
    user_id: 'u1',
  };
  let calls: Array<{ body: unknown; headers: Record<string, string>; url: string }>;

  function stubFetch(respond: () => Response | Promise<Response>): void {
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
        url: String(input),
      });
      return respond();
    }) as typeof fetch;
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function refreshError(): Promise<SessionRefreshError> {
    try {
      await CliAuthGateway.refresh('https://api.devicecloud.dev', stored);
    } catch (error) {
      expect(error).to.be.instanceOf(SessionRefreshError);
      return error as SessionRefreshError;
    }
    throw new Error('expected the refresh to fail');
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('posts the refresh token to the API and returns the new session', async () => {
    stubFetch(() =>
      json({
        access_token: 'a2',
        refresh_token: 'r2',
        expires_at: 123,
        user_email: 'u@example.com',
        user_id: 'u1',
      }),
    );

    const session = await CliAuthGateway.refresh('https://api.devicecloud.dev/', stored, {
      'x-dcd-cli-version': '9.9.9',
    });

    expect(session).to.deep.equal({
      access_token: 'a2',
      refresh_token: 'r2',
      expires_at: 123,
      user_email: 'u@example.com',
      user_id: 'u1',
    });
    expect(calls).to.have.length(1);
    expect(calls[0].url).to.equal('https://api.devicecloud.dev/cli-login/refresh');
    expect(calls[0].body).to.deep.equal({ refresh_token: 'r' });
    expect(calls[0].headers).to.include({
      'content-type': 'application/json',
      'x-dcd-cli-version': '9.9.9',
    });
  });

  it('keeps the stored email when the API sends none', async () => {
    stubFetch(() =>
      json({ access_token: 'a2', refresh_token: 'r2', expires_at: 123, user_email: '', user_id: 'u1' }),
    );

    const session = await CliAuthGateway.refresh('https://api.devicecloud.dev', stored);

    expect(session.user_email).to.equal('u@example.com');
  });

  it('says the session expired', async () => {
    stubFetch(() => json({ statusCode: 401, error: 'session_expired', message: 'Session Expired' }, 401));

    const error = await refreshError();

    expect(error.message).to.equal('Your session expired. Run `dcd login` to sign in again.');
    expect(error.code).to.equal('session_expired');
    expect(error.definitive).to.equal(true);
  });

  it('says the session was signed out when it no longer exists', async () => {
    for (const code of ['refresh_token_not_found', 'session_not_found']) {
      stubFetch(() => json({ statusCode: 401, error: code, message: 'Not Found' }, 401));

      const error = await refreshError();

      expect(error.message).to.equal('Your session was signed out. Run `dcd login` to sign in again.');
      expect(error.code).to.equal(code);
      expect(error.definitive).to.equal(true);
    }
  });

  it("keeps Supabase's message for any other refusal", async () => {
    stubFetch(() =>
      json(
        {
          statusCode: 401,
          error: 'refresh_token_already_used',
          message: 'Invalid Refresh Token: Already Used',
        },
        401,
      ),
    );

    const error = await refreshError();

    expect(error.message).to.equal(
      'Failed to refresh session: Invalid Refresh Token: Already Used. Run `dcd login` again.',
    );
    expect(error.code).to.equal('refresh_token_already_used');
    expect(error.definitive).to.equal(true);
  });

  it('treats a 400 from the API as final', async () => {
    stubFetch(() => json({ statusCode: 400, message: ['refresh_token should not be empty'] }, 400));

    const error = await refreshError();

    expect(error.definitive).to.equal(true);
  });

  for (const [label, respond] of [
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 503', () => json({ statusCode: 503, error: 'refresh_unavailable', message: 'Try again.' }, 503)],
    ['a 429', () => json({ statusCode: 429, message: 'ThrottlerException: Too Many Requests' }, 429)],
    ['a 404 from an API without the route', () => json({ statusCode: 404, message: 'Cannot POST' }, 404)],
    ['a page that is not JSON', () => new Response('<html>bad gateway</html>', { status: 502 })],
  ] as Array<[string, () => Promise<Response> | Response]>) {
    it(`keeps the stored session after ${label}`, async () => {
      stubFetch(respond);

      const error = await refreshError();

      // Not definitive, so callers keep the session and try again later.
      expect(error.definitive).to.equal(false);
      expect(error.code).to.equal(undefined);
      expect(error.message).to.not.contain('dcd login');
    });
  }
});
