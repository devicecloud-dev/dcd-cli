import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  collectFlagValues,
  decodeDataUrl,
  deviceCommand,
  newLogLines,
  parseEnvFlags,
} from '../../src/commands/device.js';
import { DeviceApiError } from '../../src/gateways/device-gateway.js';
import type { DeviceSession } from '../../src/types/domain/device-session.types.js';
import { platformOfAppFile } from '../../src/utils/app-upload.js';
import { CliError } from '../../src/utils/cli.js';
import { DEVICE_EXIT, deviceExitCode, resolveSessionId } from '../../src/utils/device-output.js';

const API = 'https://api.devicecloud.dev';
const auth = { headers: { 'x-app-api-key': 'k' }, mode: 'apiKey' as const };

function session(id: string, extra: Partial<DeviceSession> = {}): DeviceSession {
  return {
    id,
    live_id: 1,
    state: 'active',
    release_reason: null,
    platform: 'ios',
    model: 'iphone-16',
    client_label: 'dcd-cli',
    created_at: '2026-10-19T10:00:00Z',
    queue: null,
    time_remaining_s: 3600,
    idle_remaining_s: 290,
    cost_so_far_usd: 0.42,
    last_crash: null,
    warnings: [],
    monitor_url: `https://console.devicecloud.dev/device/${id}`,
    ...extra,
  };
}

/** JSON bodies parsed; anything else (a zip being PUT) kept as is. */
function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

interface Call {
  body?: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
}

/** Route fetch to `handler`, recording each call. */
function stubFetch(handler: (call: Call) => { body: unknown; status?: number }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: parseBody(init?.body),
    };
    calls.push(call);
    const { body, status = 200 } = handler(call);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Run a subcommand's `run` with --json, capturing stdout and the exit code.
 * process.exit is replaced by a throw, so a failing command stops there.
 */
async function runJson(
  name: string,
  args: Record<string, unknown>,
): Promise<{ exit: number; out: Record<string, unknown> }> {
  const sub = (deviceCommand.subCommands as Record<string, { run: (c: unknown) => Promise<void> }>)[
    name
  ];
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  const exit = process.exit;
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
  let code = 0;
  try {
    await sub.run({ args: { json: true, 'api-url': API, 'api-key': 'k', ...args }, rawArgs: [] });
  } catch (error) {
    if (!(error instanceof ExitError)) throw error;
    code = error.code;
  } finally {
    process.stdout.write = write;
    process.exit = exit;
  }

  return { exit: code, out: JSON.parse(out) as Record<string, unknown> };
}

describe('dcd device', () => {
  const realFetch = globalThis.fetch;
  const ORIGINAL_ENV = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-device-test-'));
    process.env.DCD_CONFIG_DIR = tempDir;
    process.env.DCD_TELEMETRY_DISABLED = '1';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  describe('exit codes', () => {
    const apiError = (status: number, code: null | string) =>
      new DeviceApiError('x', status, code, null);

    it('maps limits to 3 and ended or missing sessions to 4', () => {
      expect(deviceExitCode(apiError(429, 'LIVE_SPEND_CAP'))).to.equal(DEVICE_EXIT.limit);
      expect(deviceExitCode(apiError(409, 'LIVE_CONCURRENCY_LIMIT'))).to.equal(DEVICE_EXIT.limit);
      expect(deviceExitCode(apiError(429, null))).to.equal(DEVICE_EXIT.limit);
      expect(deviceExitCode(apiError(404, 'LIVE_NOT_FOUND'))).to.equal(DEVICE_EXIT.gone);
      expect(deviceExitCode(apiError(409, 'LIVE_SESSION_ENDED'))).to.equal(DEVICE_EXIT.gone);
    });

    it('maps bad input to 1 and everything else to 2', () => {
      expect(deviceExitCode(apiError(400, 'LIVE_INVALID_ACTION'))).to.equal(DEVICE_EXIT.usage);
      expect(deviceExitCode(apiError(401, null))).to.equal(DEVICE_EXIT.usage);
      expect(deviceExitCode(new CliError('bad flag'))).to.equal(DEVICE_EXIT.usage);
      expect(deviceExitCode(apiError(409, 'LIVE_HUMAN_IN_CONTROL'))).to.equal(DEVICE_EXIT.failed);
      expect(deviceExitCode(apiError(503, null))).to.equal(DEVICE_EXIT.failed);
      expect(deviceExitCode(new Error('network'))).to.equal(DEVICE_EXIT.failed);
    });
  });

  describe('the default-session rule', () => {
    it('uses the one open session', async () => {
      stubFetch(() => ({ body: { sessions: [session('brave-teal-otter')] } }));
      expect(await resolveSessionId(API, auth, undefined)).to.equal('brave-teal-otter');
    });

    it('never lists when an id is given', async () => {
      const calls = stubFetch(() => ({ body: {} }));
      expect(await resolveSessionId(API, auth, ' calm-red-fox ')).to.equal('calm-red-fox');
      expect(calls).to.have.length(0);
    });

    it('is a usage error listing the candidates when several are open', async () => {
      stubFetch(() => ({ body: { sessions: [session('a-b-c'), session('d-e-f')] } }));
      try {
        await resolveSessionId(API, auth, undefined);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(CliError);
        expect((error as CliError).exitCode).to.equal(DEVICE_EXIT.usage);
        expect((error as Error).message).to.include('a-b-c').and.include('d-e-f');
      }
    });

    it('is a usage error when none is open', async () => {
      stubFetch(() => ({ body: { sessions: [] } }));
      try {
        await resolveSessionId(API, auth, undefined);
        expect.fail('should have thrown');
      } catch (error) {
        expect((error as CliError).exitCode).to.equal(DEVICE_EXIT.usage);
        expect((error as Error).message).to.include('dcd device start');
      }
    });
  });

  describe('--json envelope', () => {
    it('prints { ok, session, data, error } on success', async () => {
      stubFetch(() => ({ body: { session: session('brave-teal-otter') } }));
      const { exit, out } = await runJson('status', { id: 'brave-teal-otter' });
      expect(exit).to.equal(0);
      expect(out).to.have.keys('ok', 'session', 'data', 'error');
      expect(out.ok).to.equal(true);
      expect((out.session as DeviceSession).id).to.equal('brave-teal-otter');
      expect(out.error).to.equal(null);
    });

    it('leaves session out for commands that are not about one session', async () => {
      stubFetch(() => ({ body: { sessions: [] } }));
      const { out } = await runJson('list', {});
      expect(out).to.have.keys('ok', 'data', 'error');
      expect(out.data).to.deep.equal({ sessions: [] });
    });

    it('carries the API code, the session and exit 4 for an ended session', async () => {
      const ended = session('brave-teal-otter', { state: 'released', release_reason: 'user_stop' });
      stubFetch(() => ({
        status: 409,
        body: {
          statusCode: 409,
          message: 'Device session "brave-teal-otter" has ended (user_stop). Start a new one.',
          error: 'LIVE_SESSION_ENDED',
          session: ended,
        },
      }));
      const { exit, out } = await runJson('launch', { id: 'brave-teal-otter' });
      expect(exit).to.equal(DEVICE_EXIT.gone);
      expect(out.ok).to.equal(false);
      expect(out.data).to.equal(null);
      expect(out.error).to.deep.equal({
        code: 'LIVE_SESSION_ENDED',
        message: 'Device session "brave-teal-otter" has ended (user_stop). Start a new one.',
      });
      expect((out.session as DeviceSession).state).to.equal('released');
    });

    it('does not read Nest status text as a code', async () => {
      stubFetch(() => ({ status: 500, body: { statusCode: 500, message: 'boom', error: 'Internal Server Error' } }));
      const { exit, out } = await runJson('status', { id: 'x-y-z' });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      expect(out.error).to.deep.equal({ code: null, message: 'boom' });
    });

    it('exits 2 with the result when a launch fails', async () => {
      stubFetch(() => ({
        body: { result: { success: false, error: 'App not installed' }, session: session('a-b-c') },
      }));
      const { exit, out } = await runJson('launch', { id: 'a-b-c', appId: 'com.example.app' });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      expect(out.ok).to.equal(false);
      expect(out.data).to.deep.equal({ result: { success: false, error: 'App not installed' } });
      expect(out.error).to.deep.equal({ code: null, message: 'App not installed' });
    });

    it('prints a usage error as an envelope too', async () => {
      stubFetch(() => ({ body: {} }));
      const { exit, out } = await runJson('start', {});
      expect(exit).to.equal(DEVICE_EXIT.usage);
      expect(out.ok).to.equal(false);
      expect((out.error as { message: string }).message).to.include('--platform');
    });
  });

  describe('install --wait', () => {
    const installed = { app: { binary_upload_id: 'b-2', app_id: 'com.x', reused: true } };
    const withInstall = (status: 'failed' | 'installed' | 'installing', error: null | string = null) =>
      session('a-b-c', { install: { binary_upload_id: 'b-2', status, error } });

    it('waits until the device has installed the build, not just until it is ready', async () => {
      let polls = 0;
      const calls = stubFetch((call) => {
        if (call.method === 'POST') return { body: { ...installed, session: withInstall('installing') } };
        polls += 1;
        return { body: { session: withInstall(polls < 2 ? 'installing' : 'installed') } };
      });
      const { exit, out } = await runJson('install', { id: 'a-b-c', 'app-binary-id': 'b-2', wait: true });
      expect(exit).to.equal(0);
      expect((out.session as DeviceSession).install?.status).to.equal('installed');
      expect(calls.filter((c) => c.method === 'GET').length).to.be.greaterThan(1);
    }).timeout(15_000);

    it('exits 2 with the reason when the install failed, and says the session is open', async () => {
      stubFetch((call) =>
        call.method === 'POST'
          ? { body: { ...installed, session: withInstall('installing') } }
          : { body: { session: withInstall('failed', 'App binary decryption failed.') } },
      );
      const { exit, out } = await runJson('install', { id: 'a-b-c', 'app-binary-id': 'b-2', wait: true });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      const message = (out.error as { message: string }).message;
      expect(message).to.include('App binary decryption failed.').and.include('a-b-c is still open');
    }).timeout(15_000);

    it('does not hang on an API without install status', async () => {
      stubFetch((call) =>
        call.method === 'POST'
          ? { body: { ...installed, session: session('a-b-c') } }
          : { body: { session: session('a-b-c') } },
      );
      const { exit } = await runJson('install', { id: 'a-b-c', 'app-binary-id': 'b-2', wait: true });
      expect(exit).to.equal(0);
    }).timeout(15_000);
  });

  describe('requests', () => {
    it('start sends the device, the label and the source header', async () => {
      const calls = stubFetch(() => ({ body: { session: session('a-b-c', { state: 'queued' }) } }));
      await runJson('start', {
        platform: 'android',
        model: 'pixel-10',
        os: '35',
        'google-play': true,
        ttl: '30',
        record: false,
      });
      expect(calls).to.have.length(1);
      expect(calls[0].method).to.equal('POST');
      expect(calls[0].url).to.equal(`${API}/device/sessions`);
      expect(calls[0].headers['x-dcd-source']).to.equal('cli');
      expect(calls[0].body).to.deep.equal({
        platform: 'android',
        clientLabel: 'dcd-cli',
        model: 'pixel-10',
        os: '35',
        googlePlay: true,
        maxDurationMin: 30,
        record: false,
      });
    });

    it('start --app with a URL starts, then installs from the URL', async () => {
      const calls = stubFetch((call) =>
        call.url.endsWith('/install')
          ? { body: { app: { binary_upload_id: 'b1', app_id: null, reused: false }, session: session('a-b-c') } }
          : { body: { session: session('a-b-c', { state: 'queued' }) } },
      );
      const { exit } = await runJson('start', { platform: 'ios', app: 'https://example.com/app.zip' });
      expect(exit).to.equal(0);
      expect(calls.map((c) => `${c.method} ${c.url}`)).to.deep.equal([
        `POST ${API}/device/sessions`,
        `POST ${API}/device/sessions/a-b-c/install`,
      ]);
      expect(calls[1].body).to.deep.equal({ url: 'https://example.com/app.zip' });
    });

    it('install takes the app as the only positional and finds the session', async () => {
      const calls = stubFetch((call) =>
        call.method === 'GET'
          ? { body: { sessions: [session('a-b-c')] } }
          : { body: { app: { binary_upload_id: 'b1', app_id: 'com.x', reused: false }, session: session('a-b-c') } },
      );
      const { exit, out } = await runJson('install', { id: 'https://example.com/app.apk' });
      expect(exit).to.equal(0);
      expect(calls[1].url).to.equal(`${API}/device/sessions/a-b-c/install`);
      expect(calls[1].body).to.deep.equal({ url: 'https://example.com/app.apk' });
      expect(out.data).to.deep.equal({ app: { binary_upload_id: 'b1', app_id: 'com.x', reused: false } });
    });

    it('launch takes a bundle id as the only positional', async () => {
      const calls = stubFetch((call) =>
        call.method === 'GET'
          ? { body: { sessions: [session('a-b-c')] } }
          : { body: { result: { success: true }, session: session('a-b-c') } },
      );
      await runJson('launch', { id: 'com.example.app', 'clear-state': true });
      expect(calls[1].url).to.equal(`${API}/device/sessions/a-b-c/launch`);
      expect(calls[1].body).to.deep.equal({ appId: 'com.example.app', clearState: true });
    });

    it('stop --all stops every open session', async () => {
      const calls = stubFetch((call) =>
        call.method === 'GET'
          ? { body: { sessions: [session('a-b-c'), session('d-e-f')] } }
          : { body: { session: session(call.url.split('/').pop()!, { state: 'released' }) } },
      );
      const { out } = await runJson('stop', { all: true });
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).to.deep.equal([
        `${API}/device/sessions/a-b-c`,
        `${API}/device/sessions/d-e-f`,
      ]);
      expect((out.data as { stopped: DeviceSession[] }).stopped).to.have.length(2);
    });
  });

  describe('inspect, screenshot, run, logs and open', () => {
    it('inspect returns the compact screen', async () => {
      const screen = { width: 390, height: 844, keys: {}, elements: [{ b: '[0,0][10,10]', txt: 'Log in' }], fresh: true };
      stubFetch(() => ({ body: { screen, session: session('a-b-c') } }));
      const { exit, out } = await runJson('inspect', { id: 'a-b-c' });
      expect(exit).to.equal(0);
      expect(out.data).to.deep.equal({ screen });
    });

    it('screenshot saves the image and reports its path', async () => {
      const file = path.join(tempDir, 'shot.jpg');
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      stubFetch(() => ({
        body: {
          screenshot: { data_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, captured_at: null, fresh: false },
          session: session('a-b-c'),
        },
      }));
      const { out } = await runJson('screenshot', { id: 'a-b-c', output: file });
      expect(fs.readFileSync(file)).to.deep.equal(jpeg);
      expect(out.data).to.deep.equal({ path: file, captured_at: null, fresh: false });
    });

    it('run sends the flow and the env, and polls a flow that is still running', async () => {
      const flowFile = path.join(tempDir, 'login.yaml');
      fs.writeFileSync(flowFile, 'appId: com.x\n---\n- launchApp\n');
      let polls = 0;
      const calls = stubFetch((call) => {
        if (call.method === 'POST') {
          return { body: { command_id: 'c1', status: 'running', result: null, session: session('a-b-c') } };
        }

        polls += 1;
        return polls < 2
          ? { body: { command_id: 'c1', status: 'running', result: null, session: session('a-b-c') } }
          : { body: { command_id: 'c1', status: 'passed', result: { success: true, output: 'ok' }, session: session('a-b-c') } };
      });
      const { exit, out } = await runJson('run', { id: 'a-b-c', flow: flowFile, env: ['USER=me', 'PASS=a=b'] });
      expect(exit).to.equal(0);
      expect(calls[0].url).to.equal(`${API}/device/sessions/a-b-c/run`);
      expect(calls[0].body).to.deep.equal({
        yaml: 'appId: com.x\n---\n- launchApp\n',
        env: { USER: 'me', PASS: 'a=b' },
      });
      expect(calls.at(-1)!.url).to.equal(`${API}/device/sessions/a-b-c/commands/c1`);
      expect(out.data).to.deep.equal({ command_id: 'c1', status: 'passed', result: { success: true, output: 'ok' } });
    }).timeout(10_000);

    it('run <dir> uploads a bundle and runs it by id', async () => {
      const flows = path.join(tempDir, 'flows');
      fs.mkdirSync(path.join(flows, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(flows, 'sub', 'login.yaml'), 'appId: x\n---\n- launchApp\n');
      const calls = stubFetch((call) => {
        if (call.url.endsWith('/upload-url')) {
          return { body: { id: 'b-1', upload: { path: 'p', signedUrl: 'https://sb/put' }, mirror: null } };
        }

        if (call.url === 'https://sb/put') return { body: {} };
        if (call.url.endsWith('/device/bundles')) {
          return { body: { bundle: { id: 'b-1', sha: 's', bytes: 1, encrypted: false, created_at: 'now' } } };
        }

        if (call.url.endsWith('/run')) {
          return { body: { command_id: 'c1', status: 'passed', result: { success: true }, session: session('a-b-c') } };
        }

        return { status: 404, body: {} };
      });
      const { exit } = await runJson('run', { id: 'a-b-c', flow: flows, entry: path.join('sub', 'login.yaml') });
      expect(exit).to.equal(0);
      const run = calls.find((c) => c.url.endsWith('/run'))!;
      expect(run.body).to.deep.equal({ flowUploadId: 'b-1', flow: 'sub/login.yaml' });
    });

    it('run --entry needs a directory and a path inside it', async () => {
      const flows = path.join(tempDir, 'flows');
      fs.mkdirSync(flows);
      expect((await runJson('run', { id: 'a-b-c', yaml: '- launchApp', entry: 'x.yaml' })).exit).to.equal(
        DEVICE_EXIT.usage,
      );
      expect((await runJson('run', { id: 'a-b-c', flow: flows, entry: '../x.yaml' })).exit).to.equal(
        DEVICE_EXIT.usage,
      );
    });

    it('run exits 2 when the flow fails', async () => {
      stubFetch(() => ({
        body: { command_id: 'c1', status: 'failed', result: { success: false, error: 'Element not found' }, session: session('a-b-c') },
      }));
      const { exit, out } = await runJson('run', { id: 'a-b-c', yaml: '- tapOn: Go' });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      expect(out.error).to.deep.equal({ code: null, message: 'Element not found' });
    });

    it('run reports the failing flows, not the runner JSON, and keeps the raw result in data', async () => {
      const report = JSON.stringify({
        success: false,
        device_id: 'emulator-5554',
        results: [{ file: 'run-test.yml', success: false, error: 'Assertion is false', message: 'Flow execution failed' }],
        env_vars: { MAESTRO_CLI_NO_ANALYTICS: 'false' },
        message: 'Some flows failed to execute',
      });
      stubFetch(() => ({
        body: { command_id: 'c1', status: 'failed', result: { success: false, error: report }, session: session('a-b-c') },
      }));
      const { exit, out } = await runJson('run', { id: 'a-b-c', yaml: '- tapOn: Go' });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      expect(out.error).to.deep.equal({ code: null, message: 'run-test.yml: Assertion is false' });
      expect((out.data as { result: { error: string } }).result.error).to.equal(report);
    });

    it('run needs a file, a directory or --yaml', async () => {
      const { exit } = await runJson('run', { id: 'a-b-c' });
      expect(exit).to.equal(DEVICE_EXIT.usage);
    });

    it('logs asks for the number of lines', async () => {
      const calls = stubFetch(() => ({
        body: { logs: { lines: ['a', 'b'], source: 'logcat', app_id: 'com.x' }, session: session('a-b-c') },
      }));
      const { out } = await runJson('logs', { id: 'a-b-c', lines: '50' });
      expect(calls[0].url).to.equal(`${API}/device/sessions/a-b-c/logs?lines=50`);
      expect(out.data).to.deep.equal({ logs: { lines: ['a', 'b'], source: 'logcat', app_id: 'com.x' } });
    });

    it('logs --follow is refused with --json', async () => {
      const { exit } = await runJson('logs', { id: 'a-b-c', follow: true });
      expect(exit).to.equal(DEVICE_EXIT.usage);
    });

    it('open gives the monitor URL and opens nothing outside a terminal', async () => {
      stubFetch(() => ({ body: { session: session('a-b-c') } }));
      const { out } = await runJson('open', { id: 'a-b-c' });
      expect(out.data).to.deep.equal({ url: 'https://console.devicecloud.dev/device/a-b-c', opened: false });
    });
  });

  describe('helpers', () => {
    it('newLogLines prints only what the last fetch did not', () => {
      expect(newLogLines(['a', 'b', 'c'], ['b', 'c', 'd', 'e'])).to.deep.equal(['d', 'e']);
      expect(newLogLines(['a', 'b'], ['a', 'b'])).to.deep.equal([]);
      expect(newLogLines(['x'], ['y', 'z'])).to.deep.equal(['y', 'z']);
      expect(newLogLines([], ['y'])).to.deep.equal(['y']);
      // A repeated line is not mistaken for the overlap.
      expect(newLogLines(['a', 'b', 'a'], ['a', 'c'])).to.deep.equal(['c']);
    });

    it('parseEnvFlags reads KEY=VALUE, once or repeated', () => {
      expect(parseEnvFlags(undefined)).to.equal(undefined);
      expect(parseEnvFlags('A=1')).to.deep.equal({ A: '1' });
      expect(parseEnvFlags(['A=1', 'B='])).to.deep.equal({ A: '1', B: '' });
      expect(() => parseEnvFlags('nope')).to.throw(CliError);
      expect(() => parseEnvFlags('=1')).to.throw(CliError);
    });

    it('collectFlagValues reads every --env', () => {
      expect(
        collectFlagValues('--env', ['run', '--env', 'A=1', '--json', '--env=B=2', '--envy', 'x']),
      ).to.deep.equal(['A=1', 'B=2']);
    });

    it('decodeDataUrl reads a JPEG data URL', () => {
      const { bytes, ext } = decodeDataUrl('data:image/jpeg;base64,/9j/');
      expect(ext).to.equal('jpg');
      expect(bytes).to.deep.equal(Buffer.from([0xff, 0xd8, 0xff]));
      expect(() => decodeDataUrl('nope')).to.throw();
    });
  });

  describe('platformOfAppFile', () => {
    it('reads the platform from the extension', () => {
      expect(platformOfAppFile('build/app.apk')).to.equal('android');
      expect(platformOfAppFile('Build/My.app/')).to.equal('ios');
      expect(platformOfAppFile('my.zip')).to.equal('ios');
      expect(platformOfAppFile('expo.tar.gz')).to.equal('ios');
      expect(platformOfAppFile('notes.txt')).to.equal(undefined);
    });
  });
});
