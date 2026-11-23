import { expect } from 'chai';

import { telemetry } from '../../src/services/telemetry.service.js';

/**
 * Events go to the API the command itself talks to. A login's stored API used
 * to win over `--api-url`, so a logged-in run aimed at a local or dev API sent
 * its events to the login's API (prod) instead.
 */
describe('telemetry API URL', () => {
  const realFetch = globalThis.fetch;
  const realArgv = process.argv;
  let urls: string[];

  beforeEach(function () {
    // The singleton reads this once, at import.
    if (process.env.DCD_TELEMETRY_DISABLED) this.skip();

    urls = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response('{}', { status: 202 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.argv = realArgv;
  });

  async function sendWith(argv: string[], storedApiUrl?: string): Promise<string> {
    process.argv = ['node', 'dcd', ...argv];
    telemetry.configure({
      apiUrl: storedApiUrl,
      auth: { headers: { authorization: 'Bearer t' }, mode: 'bearer' } as never,
    });
    telemetry.recordSubmitAttempts(1);
    telemetry.recordCommandSuccess();
    await telemetry.flush();
    return urls.pop()!;
  }

  it('follows --api-url over the login’s stored API', async () => {
    const url = await sendWith(
      ['artifacts', '--api-url', 'http://localhost:4321'],
      'https://api.devicecloud.dev',
    );
    expect(url).to.equal('http://localhost:4321/cli/logs');
  });

  it('accepts the --api-url=<url> form', async () => {
    const url = await sendWith(
      ['artifacts', '--api-url=https://dev-api.devicecloud.dev'],
      'https://api.devicecloud.dev',
    );
    expect(url).to.equal('https://dev-api.devicecloud.dev/cli/logs');
  });

  it('uses the stored API when there is no flag', async () => {
    const url = await sendWith(['artifacts'], 'https://dev-api.devicecloud.dev');
    expect(url).to.equal('https://dev-api.devicecloud.dev/cli/logs');
  });

  it('ignores a flag URL the command would refuse', async () => {
    const url = await sendWith(
      ['artifacts', '--api-url', 'http://not-local.example'],
      'https://dev-api.devicecloud.dev',
    );
    expect(url).to.equal('https://dev-api.devicecloud.dev/cli/logs');
  });

  it('falls back to the default API with neither', async () => {
    const url = await sendWith(['artifacts']);
    expect(url).to.equal('https://api.devicecloud.dev/cli/logs');
  });
});
