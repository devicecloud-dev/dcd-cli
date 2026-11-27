import { expect } from 'chai';

import {
  createProvider,
  type DeviceCloudOptions,
  type E2eDeviceRequest,
  type ProviderDeps,
} from '../../src/e2e/provider.js';

/**
 * The e2e device provider (`@devicecloud.dev/dcd/e2e`): one DeviceCloud
 * device session per e2e worker, handed to e2e as the address of the
 * session's own agent-device daemon.
 */

interface Call {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  path: string;
}

type Answer = { body: unknown; status: number };

/** A fake API: answers each `METHOD /path` from a queue, the last answer repeating. */
function fakeApi(routes: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      method,
      path: url.pathname,
    });
    const queue = routes[`${method} ${url.pathname}`];
    if (!queue?.length)
      return new Response(JSON.stringify({ message: 'no route' }), {
        status: 404,
      });
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

const session = (state: string, extra: Record<string, unknown> = {}) => ({
  session: {
    id: 'brave-teal-otter',
    monitor_url: 'https://console.example/device/brave-teal-otter',
    state,
    ...extra,
  },
});
const engine = {
  engine: {
    agentDeviceVersion: '0.21.36',
    daemon: {
      authToken: 'daemon-token',
      baseUrl: 'https://relay.example/engine/7/agent-device',
    },
    deviceId: 'emulator-5554',
  },
};

/** The happy path: queued, then ready; the engine needs one more moment. */
const happyRoutes = (): Record<string, Answer[]> => ({
  'DELETE /device/sessions/brave-teal-otter': [
    { body: session('released'), status: 200 },
  ],
  'GET /device/sessions/brave-teal-otter': [
    { body: session('provisioning'), status: 200 },
    {
      body: session('ready', { install: { status: 'installed' } }),
      status: 200,
    },
  ],
  'POST /device/sessions': [{ body: session('queued'), status: 201 }],
  'POST /device/sessions/brave-teal-otter/engine': [
    { body: { error: 'LIVE_NOT_READY', message: 'Not yet.' }, status: 425 },
    { body: engine, status: 200 },
  ],
});

function setup(
  routes: Record<string, Answer[]>,
  options: DeviceCloudOptions = {},
  deps: Partial<ProviderDeps> = {},
) {
  const api = fakeApi(routes);
  const uploads: string[] = [];
  const provider = createProvider(options, {
    fetch: api.fetch,
    pollMs: 1,
    startTimeoutMs: 60_000,
    upload: async ({ filePath }) => {
      uploads.push(filePath);
      return 'uploaded-binary-id';
    },
    version: '9.9.9',
    ...deps,
  });
  return { api, provider, uploads };
}

function request(
  overrides: Partial<E2eDeviceRequest> = {},
): E2eDeviceRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    agentDeviceVersion: '0.21.37',
    env: { DEVICE_CLOUD_API_KEY: 'key-from-env' },
    lines,
    log: (line) => lines.push(line),
    platform: 'android',
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }

  throw new Error('expected a rejection');
}

describe('the e2e device provider', () => {
  it('starts a session, waits for its device, and leases the device engine', async () => {
    const { api, provider } = setup(happyRoutes(), {
      appBinaryId: 'binary-1',
      maxDurationMin: 15,
    });
    const req = request();

    const lease = await provider.acquire(req);

    expect(lease).to.deep.equal({
      daemon: {
        authToken: 'daemon-token',
        baseUrl: 'https://relay.example/engine/7/agent-device',
      },
      deviceId: 'emulator-5554',
      id: 'brave-teal-otter',
    });
    const start = api.calls[0];
    expect(start.method).to.equal('POST');
    expect(start.path).to.equal('/device/sessions');
    expect(start.body).to.deep.equal({
      binaryUploadId: 'binary-1',
      clientLabel: 'e2e',
      maxDurationMin: 15,
      platform: 'android',
    });
    expect(start.headers).to.include({
      'x-app-api-key': 'key-from-env',
      'x-dcd-cli-version': '9.9.9',
    });
    // Two reads until ready, then the engine twice (425, then 200). Nothing stopped.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).to.deep.equal([
      'POST /device/sessions',
      'GET /device/sessions/brave-teal-otter',
      'GET /device/sessions/brave-teal-otter',
      'POST /device/sessions/brave-teal-otter/engine',
      'POST /device/sessions/brave-teal-otter/engine',
    ]);
    expect(req.lines).to.include(
      'watch at https://console.example/device/brave-teal-otter',
    );
    expect(req.lines.some((l) => l.includes('agent-device 0.21.36'))).to.equal(
      true,
    );
  });

  it('sends requests to https://api.devicecloud.dev unless told otherwise', async () => {
    const seen: string[] = [];
    const api = fakeApi(happyRoutes());
    const { provider } = setup(
      happyRoutes(),
      {},
      {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          seen.push(new URL(String(input)).origin);
          return api.fetch(input, init);
        }) as typeof fetch,
      },
    );

    await provider.acquire(request());

    expect(new Set(seen)).to.deep.equal(
      new Set(['https://api.devicecloud.dev']),
    );
  });

  it('starts the device in the locale asked for, written either way', async () => {
    for (const locale of ['en_US', 'en-US', ' en-US ']) {
      const { api, provider } = setup(happyRoutes(), { locale });
      await provider.acquire(request());
      expect(
        (api.calls[0].body as { deviceLocale?: string }).deviceLocale,
      ).to.equal('en_US');
    }

    const { api, provider } = setup(happyRoutes(), { locale: 'pt-BR' });
    await provider.acquire(request());
    expect(
      (api.calls[0].body as { deviceLocale?: string }).deviceLocale,
    ).to.equal('pt_BR');
  });

  it("leaves the device's own locale without one", async () => {
    const { api, provider } = setup(happyRoutes());
    await provider.acquire(request());
    expect(api.calls[0].body).to.not.have.property('deviceLocale');
  });

  it('refuses a locale it cannot send when the config is read, before any session starts', () => {
    for (const locale of ['english', 'en_us', 'EN-US', 'en', 'en_USA', '']) {
      expect(() => setup(happyRoutes(), { locale }), locale).to.throw(
        'is not a locale. Use a language and region, such as en_US or en-US.',
      );
    }
  });

  it('takes the key from the options before the environment', async () => {
    const { api, provider } = setup(happyRoutes(), {
      apiKey: 'key-from-options',
    });
    await provider.acquire(request());
    expect(api.calls[0].headers['x-app-api-key']).to.equal('key-from-options');
  });

  it('refuses to start without a key, and names the variable to set', async () => {
    const { api, provider } = setup(happyRoutes());
    const error = await rejection(provider.acquire(request({ env: {} })));
    expect(error.message).to.include('DEVICE_CLOUD_API_KEY');
    expect(api.calls).to.have.length(0);
  });

  it('refuses an API URL that would send the key in the clear, before sending anything', async () => {
    const { api, provider } = setup(happyRoutes(), {
      apiUrl: 'http://api.example.com',
    });
    const error = await rejection(provider.acquire(request()));
    expect(error.message).to.include('over plain http');
    expect(api.calls).to.have.length(0);
  });

  it('uploads the target build once for every worker, and tells e2e not to install it', async () => {
    const { api, provider, uploads } = setup(happyRoutes());
    const one = request({ app: 'com.example.app', appPath: '/builds/app.apk' });
    const two = request({ app: 'com.example.app', appPath: '/builds/app.apk' });

    const leases = await Promise.all([
      provider.acquire(one),
      provider.acquire(two),
    ]);

    expect(uploads).to.deep.equal(['/builds/app.apk']);
    expect(leases.map((l) => l.installedApp)).to.deep.equal([
      'com.example.app',
      'com.example.app',
    ]);
    const starts = api.calls.filter(
      (c) => c.method === 'POST' && c.path === '/device/sessions',
    );
    expect(
      starts.map((c) => (c.body as { binaryUploadId?: string }).binaryUploadId),
    ).to.deep.equal(['uploaded-binary-id', 'uploaded-binary-id']);
  });

  it('installs a given build instead of uploading the target one', async () => {
    const { api, provider, uploads } = setup(happyRoutes(), {
      appBinaryId: 'binary-1',
    });
    const lease = await provider.acquire(
      request({ app: 'com.example.app', appPath: '/builds/app.apk' }),
    );
    expect(uploads).to.deep.equal([]);
    expect(
      (api.calls[0].body as { binaryUploadId: string }).binaryUploadId,
    ).to.equal('binary-1');
    // e2e must still not install: DeviceCloud devices take builds from the session only.
    expect(lease.installedApp).to.equal('com.example.app');
  });

  it('needs the bundle id beside a target build', async () => {
    const { api, provider } = setup(happyRoutes());
    const error = await rejection(
      provider.acquire(request({ appPath: '/builds/app.apk' })),
    );
    expect(error.message).to.include('app.bundleId');
    expect(api.calls).to.have.length(0);
  });

  it('stops the session and says why when the build fails to install', async () => {
    const routes = happyRoutes();
    routes['GET /device/sessions/brave-teal-otter'] = [
      {
        body: session('ready', {
          install: {
            error: 'The app is not signed for a simulator.',
            status: 'failed',
          },
        }),
        status: 200,
      },
    ];
    const { api, provider } = setup(routes, { appBinaryId: 'binary-1' });

    const error = await rejection(provider.acquire(request()));

    expect(error.message).to.include('The app is not signed for a simulator.');
    expect(api.calls.at(-1)).to.include({
      method: 'DELETE',
      path: '/device/sessions/brave-teal-otter',
    });
  });

  it("stops the session and passes on the API's words when the engine is refused", async () => {
    const routes = happyRoutes();
    routes['POST /device/sessions/brave-teal-otter/engine'] = [
      {
        body: {
          error: 'LIVE_ENGINE_NOT_ENABLED',
          message: 'e2e is not enabled for this organization.',
        },
        status: 403,
      },
    ];
    const { api, provider } = setup(routes);

    const error = await rejection(provider.acquire(request()));

    expect(error.message).to.include(
      'e2e is not enabled for this organization.',
    );
    expect(error.message).to.include('LIVE_ENGINE_NOT_ENABLED');
    expect(api.calls.at(-1)).to.include({
      method: 'DELETE',
      path: '/device/sessions/brave-teal-otter',
    });
  });

  it('asks again when the network loses a poll, rather than ending the run', async () => {
    const api = fakeApi(happyRoutes());
    let lost = 0;
    const { provider } = setup(
      happyRoutes(),
      {},
      {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          // The second read of the session, and the first ask for the engine, never arrive.
          const key = `${init?.method} ${new URL(String(input)).pathname}`;
          const reads = api.calls.filter(
            (c) => `${c.method} ${c.path}` === key,
          ).length;
          if (
            (key === 'GET /device/sessions/brave-teal-otter' &&
              reads === 1 &&
              lost === 0) ||
            (key === 'POST /device/sessions/brave-teal-otter/engine' &&
              reads === 0 &&
              lost === 1)
          ) {
            lost++;
            throw new TypeError('fetch failed', {
              cause: { code: 'ECONNRESET' },
            });
          }

          return api.fetch(input, init);
        }) as typeof fetch,
      },
    );

    const lease = await provider.acquire(request());

    expect(lost).to.equal(2);
    expect(lease.id).to.equal('brave-teal-otter');
    expect(api.calls.filter((c) => c.method === 'DELETE')).to.have.length(0);
  });

  it('never sends a session start twice, and says what could not be reached', async () => {
    let starts = 0;
    const { provider } = setup(
      happyRoutes(),
      {},
      {
        fetch: (async () => {
          starts++;
          throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
        }) as typeof fetch,
      },
    );

    const error = await rejection(provider.acquire(request()));

    expect(starts).to.equal(1);
    expect(error.message).to.equal(
      'DeviceCloud: POST /device/sessions could not reach https://api.devicecloud.dev (ETIMEDOUT)',
    );
  });

  it('stops the session when the network stays down while it waits', async () => {
    const api = fakeApi(happyRoutes());
    const { provider } = setup(
      happyRoutes(),
      {},
      {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'GET')
            throw new TypeError('fetch failed', {
              cause: { code: 'ENETUNREACH' },
            });
          return api.fetch(input, init);
        }) as typeof fetch,
      },
    );

    const error = await rejection(provider.acquire(request()));

    expect(error.message).to.include(
      'could not reach https://api.devicecloud.dev (ENETUNREACH)',
    );
    expect(api.calls.at(-1)).to.include({
      method: 'DELETE',
      path: '/device/sessions/brave-teal-otter',
    });
  });

  it('gives up when the session ends before it is ready', async () => {
    const routes = happyRoutes();
    routes['GET /device/sessions/brave-teal-otter'] = [
      {
        body: session('failed', { release_reason: 'device_failed' }),
        status: 200,
      },
    ];
    const { provider } = setup(routes);
    const error = await rejection(provider.acquire(request()));
    expect(error.message).to.include(
      'ended before it was ready (device_failed)',
    );
  });

  it('stops waiting when the run is interrupted, and stops the session', async () => {
    const routes = happyRoutes();
    routes['GET /device/sessions/brave-teal-otter'] = [
      { body: session('queued'), status: 200 },
    ];
    const { api, provider } = setup(routes, {}, { pollMs: 50 });
    const interrupt = new AbortController();

    const acquiring = provider.acquire(request({ signal: interrupt.signal }));
    setTimeout(() => interrupt.abort(new Error('interrupted')), 120);
    const error = await rejection(acquiring);

    expect(error.message).to.equal('interrupted');
    expect(api.calls.at(-1)).to.include({
      method: 'DELETE',
      path: '/device/sessions/brave-teal-otter',
    });
  });

  it('stops the session on release, and takes a session already gone as stopped', async () => {
    const context = {
      env: { DEVICE_CLOUD_API_KEY: 'key' },
      log: () => {},
      signal: new AbortController().signal,
    };
    for (const status of [200, 404, 409]) {
      const { api, provider } = setup({
        'DELETE /device/sessions/brave-teal-otter': [{ body: {}, status }],
      });
      await provider.release({ id: 'brave-teal-otter' }, context);
      expect(api.calls).to.have.length(1);
      expect(api.calls[0]).to.include({
        method: 'DELETE',
        path: '/device/sessions/brave-teal-otter',
      });
    }

    const { provider } = setup({
      'DELETE /device/sessions/brave-teal-otter': [
        { body: { message: 'Something broke.' }, status: 500 },
      ],
    });
    const error = await rejection(
      provider.release({ id: 'brave-teal-otter' }, context),
    );
    expect(error.message).to.include('Something broke.');
  });

  describe('a test that records video', () => {
    const context = (attemptId = 'attempt-1') => ({
      attemptId,
      env: { DEVICE_CLOUD_API_KEY: 'key-from-env' },
      runId: 'run-1',
      signal: new AbortController().signal,
      targetName: 'android',
    });
    const stopContext = {
      dir: '/tmp/video',
      signal: new AbortController().signal,
    };
    const at = (iso: string) => () => Date.parse(iso);

    it("gets a console link to its part of the session's recording", async () => {
      let clock = Date.parse('2026-11-25T10:00:10.000Z');
      const { api, provider } = setup(
        {
          'GET /device/sessions/brave-teal-otter': [
            { body: session('active'), status: 200 },
          ],
        },
        {},
        { now: () => clock },
      );

      const recording = await provider.record(
        { id: 'brave-teal-otter' },
        context(),
      );
      expect(recording.startedAt).to.equal('2026-11-25T10:00:10.000Z');
      clock = Date.parse('2026-11-25T10:00:45.500Z');
      const result = await recording.stop(stopContext);

      expect(result).to.deep.equal({
        mediaType: 'text/html',
        url: 'https://console.example/device/brave-teal-otter?from=2026-11-25T10%3A00%3A10.000Z&to=2026-11-25T10%3A00%3A45.500Z',
      });
      // The session was read with the run's key; stopping asked for nothing.
      expect(api.calls).to.have.length(1);
      expect(api.calls[0].headers['x-app-api-key']).to.equal('key-from-env');
    });

    it('reads the session once per lease, however many tests record', async () => {
      const { api, provider } = setup(
        {
          'GET /device/sessions/brave-teal-otter': [
            { body: session('active'), status: 200 },
          ],
        },
        {},
        { now: at('2026-11-25T10:00:00.000Z') },
      );
      for (const attempt of ['attempt-1', 'attempt-2', 'attempt-3']) {
        const recording = await provider.record(
          { id: 'brave-teal-otter' },
          context(attempt),
        );
        await recording.stop(stopContext);
      }

      expect(api.calls.map((c) => `${c.method} ${c.path}`)).to.deep.equal([
        'GET /device/sessions/brave-teal-otter',
      ]);
    });

    it('fails, named, when the session cannot be read, and reads it again next time', async () => {
      const { api, provider } = setup(
        {
          'GET /device/sessions/brave-teal-otter': [
            { body: { message: 'Device session not found.' }, status: 404 },
            {
              body: session('active', { monitor_url: undefined }),
              status: 200,
            },
            { body: session('active'), status: 200 },
          ],
        },
        {},
        { now: at('2026-11-25T10:00:00.000Z') },
      );

      const gone = await rejection(
        provider.record({ id: 'brave-teal-otter' }, context()),
      );
      expect(gone.message).to.include(
        'reading device session brave-teal-otter',
      );
      expect(gone.message).to.include('Device session not found.');
      const noPage = await rejection(
        provider.record({ id: 'brave-teal-otter' }, context()),
      );
      expect(noPage.message).to.include('has no console page');
      const recording = await provider.record(
        { id: 'brave-teal-otter' },
        context(),
      );
      expect((await recording.stop(stopContext)).url).to.match(
        /^https:\/\/console\.example\/device\/brave-teal-otter\?from=/,
      );
      expect(api.calls).to.have.length(3);
    });
  });
});
