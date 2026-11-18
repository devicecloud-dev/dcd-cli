import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { runCommand } from 'citty';

import { Readable } from 'node:stream';

import {
  collectFlagValues,
  decodeDataUrl,
  deviceCommand,
  deviceTiming,
  formatElement,
  newLogLines,
  parseEnvFile,
  parseEnvFlags,
  readStdinText,
  startNextSteps,
  unknownSubcommandError,
} from '../../src/commands/device.js';
import { DeviceApiError, plainErrorText } from '../../src/gateways/device-gateway.js';
import type { DeviceSession } from '../../src/types/domain/device-session.types.js';
import { platformOfAppFile, platformOfAppUrl } from '../../src/utils/app-upload.js';
import { CliError } from '../../src/utils/cli.js';
import { editDistance, unknownFlags, unknownFlagsError } from '../../src/utils/device-flags.js';
import {
  checkSessionId,
  DEVICE_EXIT,
  deviceExitCode,
  formatCost,
  formatWhen,
  humanFields,
  printable,
  resolveSessionId,
} from '../../src/utils/device-output.js';

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

/** Run a subcommand's `run` without --json, capturing what it prints. */
async function runText(name: string, args: Record<string, unknown>): Promise<string> {
  const sub = (deviceCommand.subCommands as Record<string, { run: (c: unknown) => Promise<void> }>)[
    name
  ];
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  console.log = (...parts: unknown[]) => {
    out += parts.join(' ') + '\n';
  };
  try {
    await sub.run({ args: { json: false, 'api-url': API, 'api-key': 'k', ...args }, rawArgs: [] });
  } finally {
    process.stdout.write = write;
    console.log = log;
  }

  return out;
}

/**
 * Run `dcd device <rawArgs>` through citty's own parser with --json, capturing
 * the envelope and the exit code: for what the parser does to a value before
 * a subcommand sees it.
 */
async function runArgv(rawArgs: string[]): Promise<{ exit: number; out: Record<string, unknown> }> {
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
    await runCommand(deviceCommand, { rawArgs: [...rawArgs, '--json', '--api-url', API, '--api-key', 'k'] });
  } catch (error) {
    if (!(error instanceof ExitError)) throw error;
    code = error.code;
  } finally {
    process.stdout.write = write;
    process.exit = exit;
  }

  return { exit: code, out: JSON.parse(out) as Record<string, unknown> };
}

/** Run `fn`, capturing what it writes to stderr. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = '';
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = write;
  }
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CR = String.fromCharCode(13);

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
      // Another's session: as a person in control, it could not be done.
      expect(deviceExitCode(apiError(409, 'LIVE_NOT_YOURS'))).to.equal(DEVICE_EXIT.failed);
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

    it("takes your only session, never someone else's", async () => {
      stubFetch(() => ({
        body: { sessions: [session('theirs', { started_by: { api_key_name: null, client_label: 'claude-code', email: 'ann@example.com', this_client: false, you: false } }), session('yours', { started_by: { api_key_name: null, client_label: null, email: null, this_client: false, you: true } })] },
      }));
      expect(await resolveSessionId(API, auth, undefined)).to.equal('yours');
    });

    it('is a usage error, naming who started each, when none of the open sessions is yours', async () => {
      stubFetch(() => ({ body: { sessions: [session('theirs', { started_by: { api_key_name: null, client_label: 'claude-code', email: 'ann@example.com', this_client: false, you: false } })] } }));
      try {
        await resolveSessionId(API, auth, undefined);
        expect.fail('should have thrown');
      } catch (error) {
        expect((error as CliError).exitCode).to.equal(DEVICE_EXIT.usage);
        expect((error as Error).message)
          .to.include('None of the open device sessions is yours')
          .and.include('started by ann@example.com')
          .and.include('--force');
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

  describe('typed actions (tap, type, swipe, press-key)', () => {
    const ok = () => ({ body: { result: { success: true }, session: session('a-b-c') } });

    it('tap sends one target to /actions: text, id, or a point', async () => {
      const calls = stubFetch(ok);
      await runJson('tap', { id: 'a-b-c', text: 'Log in' });
      await runJson('tap', { id: 'a-b-c', rid: 'login_button' });
      await runJson('tap', { id: 'a-b-c', x: '50', y: '80.5' });
      expect(calls.map((c) => [c.method, c.url, c.body])).to.deep.equal([
        ['POST', `${API}/device/sessions/a-b-c/actions`, { type: 'tap', text: 'Log in' }],
        ['POST', `${API}/device/sessions/a-b-c/actions`, { type: 'tap', id: 'login_button' }],
        ['POST', `${API}/device/sessions/a-b-c/actions`, { type: 'tap', x: 50, y: 80.5 }],
      ]);
      expect(calls[0].headers['x-dcd-source']).to.equal('cli');
    });

    it('tap refuses no target, two targets and a bad percentage without calling the API', async () => {
      const calls = stubFetch(ok);
      for (const args of [
        { id: 'a-b-c' },
        { id: 'a-b-c', text: 'x', rid: 'y' },
        { id: 'a-b-c', x: '150', y: '10' },
        { id: 'a-b-c', x: 'left', y: '10' },
      ]) {
        const { exit, out } = await runJson('tap', args);
        expect(exit).to.equal(DEVICE_EXIT.usage);
        expect(out.ok).to.equal(false);
      }
      expect(calls).to.have.length(0);
    });

    it('--maestro is still accepted and changes nothing: device sessions have one engine', async () => {
      const calls = stubFetch(ok);
      const { exit } = await runJson('tap', { id: 'a-b-c', text: 'OK', maestro: true });
      expect(exit).to.equal(0);
      expect(calls[0].body).to.deep.equal({ type: 'tap', text: 'OK' });
    });

    it('type sends the text, sensitive when asked, and keeps it out of the envelope', async () => {
      const calls = stubFetch(ok);
      const { out } = await runJson('type', { id: 'a-b-c', text: 'hunter2', sensitive: true });
      expect(calls[0].body).to.deep.equal({ type: 'type', text: 'hunter2', sensitive: true });
      expect(JSON.stringify(out)).to.not.include('hunter2');
      await runJson('type', { id: 'a-b-c', text: 'hello' });
      expect(calls[1].body).to.deep.equal({ type: 'type', text: 'hello' });
    });

    it('type without --text is a usage error inside the envelope, not a citty error', async () => {
      const calls = stubFetch(ok);
      const { exit, out } = await runJson('type', { id: 'a-b-c' });
      expect(exit).to.equal(DEVICE_EXIT.usage);
      expect(out).to.have.keys('ok', 'session', 'data', 'error');
      expect(out.ok).to.equal(false);
      expect((out.error as { message: string }).message).to.include('--text');
      expect(calls).to.have.length(0);
    });

    it('swipe takes a direction as its only positional, or --from and --to', async () => {
      const calls = stubFetch((call) =>
        call.url.endsWith('/device/sessions') ? { body: { sessions: [session('a-b-c')] } } : ok(),
      );
      await runJson('swipe', { id: 'up' });
      await runJson('swipe', { id: 'a-b-c', direction: 'left' });
      await runJson('swipe', { id: 'a-b-c', from: '90,50', to: '10, 50' });
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts.map((c) => c.body)).to.deep.equal([
        { type: 'swipe', direction: 'up' },
        { type: 'swipe', direction: 'left' },
        { type: 'swipe', from: { x: 90, y: 50 }, to: { x: 10, y: 50 } },
      ]);
      const { exit } = await runJson('swipe', { id: 'a-b-c', direction: 'sideways' });
      expect(exit).to.equal(DEVICE_EXIT.usage);
      const both = await runJson('swipe', { id: 'a-b-c', direction: 'up', from: '1,1', to: '2,2' });
      expect(both.exit).to.equal(DEVICE_EXIT.usage);
    });

    it('press-key takes the key as its only positional when the session is implied', async () => {
      const calls = stubFetch((call) =>
        call.url.endsWith('/device/sessions') ? { body: { sessions: [session('a-b-c')] } } : ok(),
      );
      await runJson('press-key', { id: 'back' });
      await runJson('press-key', { id: 'a-b-c', key: 'enter' });
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts.map((c) => [c.url, c.body])).to.deep.equal([
        [`${API}/device/sessions/a-b-c/actions`, { type: 'press_key', key: 'back' }],
        [`${API}/device/sessions/a-b-c/actions`, { type: 'press_key', key: 'enter' }],
      ]);
      const { exit } = await runJson('press-key', { id: 'a-b-c', key: 'menu' });
      expect(exit).to.equal(DEVICE_EXIT.usage);
    });

    it('tap --timeout rides on a tap by text or id, in seconds', async () => {
      const calls = stubFetch(ok);
      await runJson('tap', { id: 'a-b-c', rid: 'login_button', timeout: '2.5' });
      await runJson('tap', { id: 'a-b-c', text: 'Log in', timeout: '0' });
      expect(calls.map((c) => c.body)).to.deep.equal([
        { type: 'tap', id: 'login_button', timeoutSeconds: 2.5 },
        // 0 is a wait of its own: look once.
        { type: 'tap', text: 'Log in', timeoutSeconds: 0 },
      ]);
    });

    it('tap --timeout is refused with a point, out of range or not a number, without calling the API', async () => {
      const calls = stubFetch(ok);
      for (const args of [
        { id: 'a-b-c', x: '50', y: '50', timeout: '2' },
        { id: 'a-b-c', text: 'x', timeout: '61' },
        { id: 'a-b-c', text: 'x', timeout: '-1' },
        { id: 'a-b-c', text: 'x', timeout: 'soon' },
        { id: 'a-b-c', text: 'x', timeout: '' },
      ]) {
        const { exit, out } = await runJson('tap', args);
        expect(exit, JSON.stringify(args)).to.equal(DEVICE_EXIT.usage);
        expect(out.ok).to.equal(false);
      }
      expect(calls).to.have.length(0);
    });

    it('open-link takes the link as its only positional when the session is implied', async () => {
      const calls = stubFetch((call) =>
        call.url.endsWith('/device/sessions') ? { body: { sessions: [session('a-b-c')] } } : ok(),
      );
      await runJson('open-link', { id: 'myapp://sign-in?user=a' });
      await runJson('open-link', { id: 'a-b-c', url: 'https://example.com/page?a=1&b=2' });
      await runJson('open-link', { id: 'a-b-c', url: 'myapp://sign-in?token=abc', sensitive: true });
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts.map((c) => [c.url, c.body])).to.deep.equal([
        [`${API}/device/sessions/a-b-c/actions`, { type: 'open_link', url: 'myapp://sign-in?user=a' }],
        [`${API}/device/sessions/a-b-c/actions`, { type: 'open_link', url: 'https://example.com/page?a=1&b=2' }],
        [
          `${API}/device/sessions/a-b-c/actions`,
          { type: 'open_link', url: 'myapp://sign-in?token=abc', sensitive: true },
        ],
      ]);
    });

    it('open-link refuses no link, no scheme and a space, without calling the API', async () => {
      const calls = stubFetch(ok);
      for (const args of [
        { id: 'a-b-c' },
        { id: 'a-b-c', url: 'example.com/page' },
        { id: 'a-b-c', url: 'myapp://a b' },
        { id: 'a-b-c', url: ':nothing' },
      ]) {
        const { exit, out } = await runJson('open-link', args);
        expect(exit, JSON.stringify(args)).to.equal(DEVICE_EXIT.usage);
        expect(out.ok).to.equal(false);
      }
      expect(calls).to.have.length(0);
    });

    it('open-link --sensitive does not print the link', async () => {
      stubFetch(ok);
      const shown = await runText('open-link', { id: 'a-b-c', url: 'myapp://sign-in?user=a' });
      expect(shown).to.contain('myapp://sign-in?user=a');
      const hidden = await runText('open-link', {
        id: 'a-b-c',
        url: 'myapp://sign-in?token=hunter2',
        sensitive: true,
      });
      expect(hidden).to.contain('Opened a link');
      expect(hidden).to.not.contain('hunter2');
    });

    it('set-location sends decimal degrees, south and west as negative numbers', async () => {
      const calls = stubFetch((call) =>
        call.url.endsWith('/device/sessions') ? { body: { sessions: [session('a-b-c')] } } : ok(),
      );
      await runJson('set-location', { id: 'a-b-c', latitude: '51.5074', longitude: '-0.1278' });
      // Through citty's own parser too: a value that starts with `-` must arrive as the number it is.
      const south = await runArgv(['set-location', 'a-b-c', '--latitude', '-33.86882', '--longitude', '151.2093']);
      expect(south.exit).to.equal(0);
      const west = await runArgv(['set-location', '--latitude=40.7128', '--longitude', '-74.006']);
      expect(west.exit).to.equal(0);
      const nearZero = await runArgv(['set-location', '--latitude', '-0.5', '--longitude', '-0.1278']);
      expect(nearZero.exit).to.equal(0);
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts.map((c) => [c.url, c.body])).to.deep.equal([
        [`${API}/device/sessions/a-b-c/actions`, { type: 'set_location', latitude: 51.5074, longitude: -0.1278 }],
        [`${API}/device/sessions/a-b-c/actions`, { type: 'set_location', latitude: -33.86882, longitude: 151.2093 }],
        [`${API}/device/sessions/a-b-c/actions`, { type: 'set_location', latitude: 40.7128, longitude: -74.006 }],
        [`${API}/device/sessions/a-b-c/actions`, { type: 'set_location', latitude: -0.5, longitude: -0.1278 }],
      ]);
    });

    it('set-location refuses a missing, out-of-range or non-numeric coordinate, without calling the API', async () => {
      const calls = stubFetch(ok);
      for (const args of [
        { id: 'a-b-c' },
        { id: 'a-b-c', latitude: '51.5' },
        { id: 'a-b-c', latitude: '90.1', longitude: '0' },
        { id: 'a-b-c', latitude: '0', longitude: '-180.5' },
        { id: 'a-b-c', latitude: 'north', longitude: '0' },
        { id: 'a-b-c', latitude: '', longitude: '0' },
      ]) {
        const { exit, out } = await runJson('set-location', args);
        expect(exit, JSON.stringify(args)).to.equal(DEVICE_EXIT.usage);
        expect(out.ok).to.equal(false);
      }
      expect(calls).to.have.length(0);
    });

    it('exits 2 with the result when the device could not do the action', async () => {
      stubFetch(() => ({
        body: { result: { success: false, error: 'Element not found: "Nope"' }, session: session('a-b-c') },
      }));
      const { exit, out } = await runJson('tap', { id: 'a-b-c', text: 'Nope' });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      expect(out.ok).to.equal(false);
      expect(out.data).to.deep.equal({ result: { success: false, error: 'Element not found: "Nope"' } });
      expect(out.error).to.deep.equal({ code: null, message: 'Element not found: "Nope"' });
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

    describe('a start that may have made a session anyway', () => {
      // What Railway's proxy answers when the API did not reply in time.
      const proxy502 = {
        status: 502,
        body: { status: 'error', code: 502, message: 'Application failed to respond', request_id: 'r-1' },
      };
      const justNow = () => new Date().toISOString();
      const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000).toISOString();

      it('names the session a proxy 502 hid, and says how to stop it', async () => {
        const calls = stubFetch((call) =>
          call.method === 'POST'
            ? proxy502
            : {
                body: {
                  sessions: [
                    session('jolly-orange-lion', { state: 'provisioning', created_at: justNow() }),
                    session('old-one', { created_at: tenMinutesAgo() }),
                  ],
                },
              },
        );
        const { exit, out } = await runJson('start', { platform: 'ios' });
        expect(exit).to.equal(DEVICE_EXIT.failed);
        const message = (out.error as { message: string }).message;
        expect(message)
          .to.include('Application failed to respond')
          .and.include('may still have started a session')
          .and.include('jolly-orange-lion')
          .and.include('dcd device stop');
        expect(message).to.not.include('old-one');
        expect((out.session as DeviceSession).id).to.equal('jolly-orange-lion');
        expect(calls.map((c) => c.method)).to.deep.equal(['POST', 'GET']);
      });

      it('says it is safe to start again when no session was made', async () => {
        stubFetch((call) =>
          call.method === 'POST'
            ? proxy502
            : { body: { sessions: [session('old-one', { created_at: tenMinutesAgo() })] } },
        );
        const { exit, out } = await runJson('start', { platform: 'ios' });
        expect(exit).to.equal(DEVICE_EXIT.failed);
        expect((out.error as { message: string }).message).to.include('safe to start one again');
        expect(out.session ?? null).to.equal(null);
      });

      it('treats a start with no answer at all the same way', async () => {
        stubFetch((call) => {
          if (call.method === 'POST') throw new TypeError('fetch failed');
          return { body: { sessions: [session('jolly-orange-lion', { created_at: justNow() })] } };
        });
        const { exit, out } = await runJson('start', { platform: 'ios' });
        expect(exit).to.equal(DEVICE_EXIT.failed);
        expect((out.error as { message: string }).message)
          .to.include('may still have started a session')
          .and.include('jolly-orange-lion');
      });

      it('says to check `dcd device list` when the sessions cannot be read either', async () => {
        stubFetch(() => proxy502);
        const { exit, out } = await runJson('start', { platform: 'ios' });
        expect(exit).to.equal(DEVICE_EXIT.failed);
        expect((out.error as { message: string }).message)
          .to.include('may still have started a session')
          .and.include('dcd device list');
      });

      it("leaves the API's own errors alone: they come before any session exists", async () => {
        for (const [status, message] of [
          [500, 'Failed to create live session'],
          [503, 'Could not check your live spend cap right now (a temporary problem on our side). Please retry.'],
        ] as const) {
          const calls = stubFetch(() => ({ status, body: { statusCode: status, message, error: 'Error' } }));
          const { exit, out } = await runJson('start', { platform: 'ios' });
          expect(exit).to.equal(DEVICE_EXIT.failed);
          expect((out.error as { message: string }).message).to.equal(message);
          expect(calls).to.have.length(1);
        }
      });
    });

    describe('start --model without --platform', () => {
      const catalogue = {
        ios: [{ model: 'iphone-16', name: 'iPhone 16', os: ['18'], default_os: '18', google_play: false, default: true }],
        android: [
          { model: 'pixel-10', name: 'Pixel 10', os: ['36'], default_os: '36', google_play: true, default: true },
          { model: 'iphone-16', name: 'Clash', os: ['36'], default_os: '36', google_play: false, default: false },
        ],
      };

      it('reads the platform from the model list', async () => {
        const calls = stubFetch((call) =>
          call.url.endsWith('/device/models') ? { body: catalogue } : { body: { session: session('a-b-c') } },
        );
        const { exit } = await runJson('start', { model: 'Pixel 10' });
        expect(exit).to.equal(0);
        const start = calls.find((c) => c.method === 'POST')!;
        expect(start.body).to.include({ platform: 'android', model: 'Pixel 10' });
      });

      it('is a usage error for an unknown model, or one on both platforms', async () => {
        stubFetch(() => ({ body: catalogue }));
        const unknown = await runJson('start', { model: 'nokia-3310' });
        expect(unknown.exit).to.equal(DEVICE_EXIT.usage);
        expect((unknown.out.error as { message: string }).message).to.include('dcd device models');
        const both = await runJson('start', { model: 'iphone-16' });
        expect(both.exit).to.equal(DEVICE_EXIT.usage);
        expect((both.out.error as { message: string }).message).to.include('--platform');
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

    it("stop --all stops your sessions and leaves others' unless --force", async () => {
      const calls = stubFetch((call) =>
        call.method === 'GET'
          ? { body: { sessions: [session('mine-1', { started_by: { api_key_name: null, client_label: null, email: null, this_client: false, you: true } }), session('theirs', { started_by: { api_key_name: null, client_label: 'claude-code', email: 'ann@example.com', this_client: false, you: false } })] } }
          : { body: { session: session(call.url.split('/').pop()!.split('?')[0], { state: 'released' }) } },
      );
      const { out } = await runJson('stop', { all: true });
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).to.deep.equal([
        `${API}/device/sessions/mine-1`,
      ]);
      expect((out.data as { left: string[] }).left).to.deep.equal(['theirs']);

      calls.length = 0;
      await runJson('stop', { all: true, force: true });
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).to.deep.equal([
        `${API}/device/sessions/mine-1?force=true`,
        `${API}/device/sessions/theirs?force=true`,
      ]);
    });

    it('--force asks the API to change a session someone else started', async () => {
      const calls = stubFetch((call) =>
        call.method === 'DELETE'
          ? { body: { session: session('theirs', { state: 'released' }) } }
          : { body: { result: { success: true }, session: session('theirs') } },
      );
      await runJson('stop', { id: 'their-red-fox', force: true });
      expect(calls[0].url).to.equal(`${API}/device/sessions/their-red-fox?force=true`);
      await runJson('press-key', { id: 'their-red-fox', key: 'back', force: true });
      expect(calls[1].body).to.deep.equal({ force: true, key: 'back', type: 'press_key' });
      // Without it, nothing extra is sent: an older API sees what it always did.
      await runJson('press-key', { id: 'their-red-fox', key: 'back' });
      expect(calls[2].body).to.deep.equal({ key: 'back', type: 'press_key' });
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

    it('inspect --all asks for the keyboard and System UI too', async () => {
      const screen = { width: 390, height: 844, keys: {}, elements: [], fresh: true };
      const calls = stubFetch(() => ({ body: { screen, session: session('a-b-c') } }));
      await runJson('inspect', { id: 'a-b-c' });
      await runJson('inspect', { id: 'a-b-c', all: true });
      expect(calls.map((c) => c.url)).to.deep.equal([
        `${API}/device/sessions/a-b-c/inspect`,
        `${API}/device/sessions/a-b-c/inspect?all=true`,
      ]);
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

  describe('a person in the loop', () => {
    const human = (extra: Record<string, unknown> = {}) => ({
      waiting: false,
      reason: null,
      since: null,
      expires_at: null,
      handed_back: false,
      note: null,
      handed_back_at: null,
      human_in_control: false,
      controller_user_id: null,
      ...extra,
    });
    const waiting = human({ waiting: true, reason: 'Enter the 2FA code', since: '2026-10-19T10:00:00Z' });
    const handedBack = human({ handed_back: true, note: 'Code entered', handed_back_at: '2026-10-19T10:02:00Z' });

    it('request-human sends the reason and returns where it stands', async () => {
      const calls = stubFetch(() => ({ body: { human: waiting, session: session('a-b-c', { state: 'needs_human' }) } }));
      const { exit, out } = await runJson('request-human', { reason: ' Enter the 2FA code ', id: 'a-b-c' });
      expect(exit).to.equal(0);
      expect(calls).to.have.length(1);
      expect(calls[0].method).to.equal('POST');
      expect(calls[0].url).to.equal(`${API}/device/sessions/a-b-c/request-human`);
      expect(calls[0].body).to.deep.equal({ reason: 'Enter the 2FA code' });
      expect(out.data).to.deep.equal({ human: waiting });
    });

    it('request-human needs a reason', async () => {
      const calls = stubFetch(() => ({ body: {} }));
      const { exit } = await runJson('request-human', { reason: '  ', id: 'a-b-c' });
      expect(exit).to.equal(DEVICE_EXIT.usage);
      expect(calls).to.have.length(0);
    });

    it('request-human with no reason fails with the --json envelope', async () => {
      // Through citty's parser, not run(): a required positional would be
      // refused before run() and print a different shape.
      const calls = stubFetch(() => ({ body: {} }));
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
        await runCommand(deviceCommand, { rawArgs: ['request-human', '--json', '--api-url', API, '--api-key', 'k'] });
      } catch (error) {
        if (!(error instanceof ExitError)) throw error;
        code = error.code;
      } finally {
        process.stdout.write = write;
        process.exit = exit;
      }

      const envelope = JSON.parse(out) as { error: { message: string }; ok: boolean };
      expect(code).to.equal(DEVICE_EXIT.usage);
      expect(envelope.ok).to.equal(false);
      expect(envelope.error.message).to.match(/what the person should do/i);
      expect(calls).to.have.length(0);
    });

    it('request-human --wait polls until the session is handed back', async () => {
      let polls = 0;
      const calls = stubFetch((call) => {
        if (call.method === 'POST') return { body: { human: waiting, session: session('a-b-c', { state: 'needs_human' }) } };
        polls += 1;
        return { body: { human: handedBack, session: session('a-b-c') } };
      });
      const { exit, out } = await runJson('request-human', { reason: 'Enter the 2FA code', id: 'a-b-c', wait: true });
      expect(exit).to.equal(0);
      expect(polls).to.equal(1);
      expect(calls.at(-1)!.url).to.equal(`${API}/device/sessions/a-b-c/human`);
      expect((out.data as { human: { note: string } }).human.note).to.equal('Code entered');
    }).timeout(15_000);

    it('human --wait returns at once when nobody is waiting', async () => {
      const calls = stubFetch(() => ({ body: { human: handedBack, session: session('a-b-c') } }));
      const { exit, out } = await runJson('human', { id: 'a-b-c', wait: true });
      expect(exit).to.equal(0);
      expect(calls).to.have.length(1);
      expect(out.data).to.deep.equal({ human: handedBack });
    });

    it('human --wait exits 4 when the session ends while waiting', async () => {
      stubFetch(() => ({
        body: { human: waiting, session: session('a-b-c', { state: 'expired', release_reason: 'needs_human_timeout' }) },
      }));
      const { exit, out } = await runJson('human', { id: 'a-b-c', wait: true });
      expect(exit).to.equal(DEVICE_EXIT.gone);
      expect((out.error as { message: string }).message).to.include('ended while waiting for a person');
    });

    it('status carries the hand-back', async () => {
      stubFetch((call) =>
        call.url.endsWith('/human')
          ? { body: { human: handedBack, session: session('a-b-c') } }
          : { body: { session: session('a-b-c') } },
      );
      const { out } = await runJson('status', { id: 'a-b-c' });
      expect(out.data).to.deep.equal({ human: handedBack });
    });

    it('status says a person has control once, not twice', async () => {
      const inControl = human({ waiting: true, reason: 'a@b.c took control', human_in_control: true });
      const waitingWarning =
        'Waiting for a human: a@b.c took control. The session ends in 900s unless they hand it back. Poll get_human_status (MCP) or run `dcd device human --wait`; the idle timer is paused meanwhile.';
      stubFetch((call) =>
        call.url.endsWith('/human')
          ? { body: { human: inControl, session: session('a-b-c', { state: 'needs_human' }) } }
          : { body: { session: session('a-b-c', { state: 'needs_human', warnings: [waitingWarning] }) } },
      );
      const withApiWarning = await runText('status', { id: 'a-b-c' });
      expect(withApiWarning).to.include('Waiting for a human');
      expect(withApiWarning).not.to.include('A person has control');

      stubFetch((call) =>
        call.url.endsWith('/human')
          ? { body: { human: inControl, session: session('a-b-c', { state: 'needs_human' }) } }
          : { body: { session: session('a-b-c', { state: 'needs_human' }) } },
      );
      expect(await runText('status', { id: 'a-b-c' })).to.include('A person has control');
    });

    it('status still works on an API without the human route', async () => {
      stubFetch((call) =>
        call.url.endsWith('/human') ? { status: 404, body: { statusCode: 404, message: 'Not Found' } } : { body: { session: session('a-b-c') } },
      );
      const { exit, out } = await runJson('status', { id: 'a-b-c' });
      expect(exit).to.equal(0);
      expect(out.data).to.equal(null);
    });

    it('a driving command blocked by a person says how to wait for them', async () => {
      stubFetch(() => ({
        status: 409,
        body: { statusCode: 409, message: 'A person has taken control of this device.', error: 'LIVE_HUMAN_IN_CONTROL' },
      }));
      const { exit, out } = await runJson('launch', { id: 'a-b-c' });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      const error = out.error as { code: string; message: string };
      expect(error.code).to.equal('LIVE_HUMAN_IN_CONTROL');
      expect(error.message).to.include('A person has taken control of a-b-c');
      expect(error.message).to.include('dcd device human a-b-c --wait');
    });
  });

  describe('helpers', () => {
    it('formatElement shows state that is not the default', () => {
      const line = stripVTControlCharacters(
        formatElement({ b: '[0,0][1,1]', txt: 'English', selected: true, checked: true, enabled: false }),
      );
      expect(line).to.equal('"English"  checked  selected  disabled  [0,0][1,1]');
    });

    it('startNextSteps fits the session: check readiness first, install only with no app', () => {
      const cmds = (s: DeviceSession, hasApp: boolean) => startNextSteps(s, hasApp).map(([, cmd]) => cmd);

      expect(cmds(session('a', { state: 'queued' }), false)).to.deep.equal([
        'dcd device status a',
        'dcd device install a <app>',
        'dcd device inspect a',
        'dcd device run a flow.yaml',
        'dcd device stop a',
        'dcd device --help',
      ]);
      expect(cmds(session('a', { state: 'ready' }), true)).to.deep.equal([
        'dcd device inspect a',
        'dcd device run a flow.yaml',
        'dcd device stop a',
        'dcd device --help',
      ]);
    });

    it('formatWhen says how far off a time is', () => {
      const now = Date.parse('2026-10-19T10:00:00Z');
      expect(formatWhen('2026-10-19T10:12:00Z', now)).to.match(/^in 12m \(.+\)$/);
      expect(formatWhen('2026-10-19T09:57:30Z', now)).to.match(/^2m 30s ago \(.+\)$/);
      expect(formatWhen('not a time', now)).to.equal('not a time');
    });

    it('humanFields shows the reason while waiting and the note once handed back', () => {
      const base = {
        waiting: true,
        reason: 'Enter the 2FA code',
        since: '2026-10-19T10:00:00Z',
        expires_at: '2026-10-19T10:30:00Z',
        handed_back: false,
        note: null,
        handed_back_at: null,
        human_in_control: false,
        controller_user_id: null,
      };
      const now = Date.parse('2026-10-19T10:00:00Z');
      const labels = (h: typeof base | Record<string, unknown>) =>
        humanFields(h as typeof base, now).map(([label]) => label);
      expect(labels(base)).to.deep.equal(['state', 'reason', 'asked', 'ends']);
      // Taken unasked: "since", not "asked". A request a person picked up stays "asked".
      expect(labels({ ...base, human_in_control: true, reason: 'ann@x.com took control' })).to.deep.equal(['state', 'reason', 'since', 'ends']);
      expect(labels({ ...base, human_in_control: true })).to.deep.equal(['state', 'reason', 'asked', 'ends']);
      const back = { ...base, waiting: false, reason: null, since: null, handed_back: true, note: 'Done', handed_back_at: '2026-10-19T10:00:00Z' };
      expect(humanFields(back, now)).to.deep.include(['note', 'Done']);
      expect(humanFields(back, now)[0]).to.deep.equal(['state', 'handed back']);
    });

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

  describe('flags and ids a command does not take', () => {
    it('refuses an unknown flag, says which was meant, and sends nothing', async () => {
      const calls = stubFetch(() => ({ body: {} }));
      const { exit, out } = await runArgv(['type', 'a-b-c', '--text', 'hunter2', '--sensetive']);
      expect(exit).to.equal(DEVICE_EXIT.usage);
      const { message } = out.error as { message: string };
      expect(message).to.include('Unknown flag --sensetive.').and.include('Did you mean --sensitive?');
      expect(calls).to.have.length(0);
    });

    it('catches a swapped pair of letters, a misspelt negation, and the session given as a flag', async () => {
      stubFetch(() => ({ body: {} }));
      const wait = await runArgv(['start', '--platform', 'ios', '--wiat']);
      expect((wait.out.error as { message: string }).message).to.include('Did you mean --wait?');
      const record = await runArgv(['start', '--platform', 'ios', '--no-recrod']);
      expect((record.out.error as { message: string }).message).to.include('Did you mean --no-record?');
      const session = await runArgv(['tap', '--session', 'a-b-c', '--text', 'OK']);
      expect((session.out.error as { message: string }).message).to.include('The session id is an argument');
      const secret = await runArgv(['type', 'a-b-c', '--text', 'x', '--secret']);
      expect((secret.out.error as { message: string }).message).to.include('Did you mean --sensitive?');
    });

    it("reads a flag's value as a value, even one that starts with a dash", () => {
      const args = {
        id: { type: 'positional' as const },
        json: { type: 'boolean' as const },
        output: { type: 'string' as const, alias: ['o'] },
        record: { type: 'boolean' as const, default: true },
        'clear-state': { type: 'boolean' as const },
        yaml: { type: 'string' as const },
      };
      expect(unknownFlags(['a-b-c', '--yaml', '- launchApp', '-o', 'shot.jpg', '--no-record', '--json'], args)).to.deep.equal([]);
      expect(unknownFlags(['--clearState', '--yaml=-x', '--', '--anything'], args)).to.deep.equal([]);
      expect(unknownFlags(['-x', '--nope=1', '--yaml'], args)).to.deep.equal(['-x', '--nope']);
      expect(unknownFlagsError(['--clear-sate'], args)!.message).to.include('Did you mean --clear-state?');
      // Nothing close: no guess.
      expect(unknownFlagsError(['--banana'], args)!.message).not.to.include('Did you mean');
      expect(editDistance('wiat', 'wait')).to.equal(1);
      expect(editDistance('sensetive', 'sensitive')).to.equal(1);
    });

    it('refuses an unknown command with the envelope, and names the one meant', async () => {
      const calls = stubFetch(() => ({ body: {} }));
      const { exit, out } = await runArgv(['press_key', 'back']);
      expect(exit).to.equal(DEVICE_EXIT.usage);
      expect(out.ok).to.equal(false);
      expect((out.error as { message: string }).message).to.include('Did you mean `dcd device press-key`?');
      expect(calls).to.have.length(0);
      expect(unknownSubcommandError('tap_on').message).to.include('`dcd device tap`');
      expect(unknownSubcommandError('frobnicate').message).not.to.include('Did you mean');
    });

    it("refuses an id that can't be a session, such as a variable that was not set", async () => {
      const calls = stubFetch(() => ({ body: {} }));
      for (const id of ['undefined', 'null', 'None', '[object Object]']) {
        const { exit, out } = await runJson('launch', { id });
        expect(exit).to.equal(DEVICE_EXIT.usage);
        expect((out.error as { message: string }).message).to.include('was not set');
      }

      expect((await runJson('inspect', { id: 'Brave Teal Otter' })).exit).to.equal(DEVICE_EXIT.usage);
      expect(calls).to.have.length(0);
      expect(checkSessionId(' brave-teal-otter ')).to.equal('brave-teal-otter');
      expect(checkSessionId('brave-teal-otter-0042')).to.equal('brave-teal-otter-0042');
      expect(checkSessionId('teal-otter-42')).to.equal('teal-otter-42');
      expect(checkSessionId('1234')).to.equal('1234');
      expect(checkSessionId('   ')).to.equal(undefined);
    });

    it("passes on what the API said a script can act on: retry_after_s, limit, phase", async () => {
      stubFetch(() => ({
        status: 429,
        body: { statusCode: 429, message: 'Too many commands', error: 'LIVE_RATE_LIMITED', limit: 60, retry_after_s: 12 },
      }));
      const limited = await runJson('tap', { id: 'a-b-c', text: 'OK' });
      expect(limited.exit).to.equal(DEVICE_EXIT.limit);
      expect(limited.out.error).to.deep.equal({
        code: 'LIVE_RATE_LIMITED',
        message: 'Too many commands',
        limit: 60,
        retry_after_s: 12,
      });
      stubFetch(() => ({
        status: 409,
        body: { statusCode: 409, message: 'The app is still installing', error: 'LIVE_NOT_READY', phase: 'installing_app' },
      }));
      expect((await runJson('tap', { id: 'a-b-c', text: 'OK' })).out.error).to.include({ phase: 'installing_app' });
    });

    it('shortens an HTML error page to its title', () => {
      const page = '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>' + 'x'.repeat(5000) + '</body></html>';
      expect(plainErrorText(page, 502)).to.equal("HTTP 502: 502 Bad Gateway (an HTML page, not the API's answer)");
      expect(plainErrorText('', 503)).to.equal('HTTP 503');
      expect(plainErrorText('y'.repeat(1000), 500)).to.have.length(301);
    });
  });

  describe('waiting', () => {
    const saved = { ...deviceTiming };
    beforeEach(() => Object.assign(deviceTiming, { pollMs: 5, retryBaseMs: 5, runGraceMs: 60_000 }));
    afterEach(() => Object.assign(deviceTiming, saved));

    const running = (extra: Partial<DeviceSession> = {}) => ({
      body: { command_id: 'c1', status: 'running', result: null, session: session('a-b-c', extra) },
    });

    it('run stops waiting when the session ends under the flow: exit 4, with the command id', async () => {
      stubFetch((call) => (call.method === 'POST' ? running() : running({ state: 'released', release_reason: 'idle_timeout' })));
      const { exit, out } = await runJson('run', { id: 'a-b-c', yaml: '- launchApp' });
      expect(exit).to.equal(DEVICE_EXIT.gone);
      expect(out.error).to.include({ code: 'LIVE_SESSION_ENDED', command_id: 'c1' });
      expect((out.error as { message: string }).message).to.include('ended before the flow finished');
    });

    it("run gives up once the session's time is over, with the command id", async () => {
      deviceTiming.runGraceMs = 0;
      stubFetch(() => running({ time_remaining_s: 0 }));
      const { exit, out } = await runJson('run', { id: 'a-b-c', yaml: '- launchApp' });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      expect(out.error).to.include({ command_id: 'c1' });
      expect((out.error as { message: string }).message).to.include('maximum duration');
    });

    it('run asks again when a poll fails on the way, and keeps waiting', async () => {
      let polls = 0;
      stubFetch((call) => {
        if (call.method === 'POST') return running();
        polls += 1;
        // A proxy's answer, not the API's: nothing was decided.
        if (polls === 1) return { status: 502, body: { message: 'Application failed to respond' } };
        return { body: { command_id: 'c1', status: 'passed', result: { success: true }, session: session('a-b-c') } };
      });
      const { exit } = await runJson('run', { id: 'a-b-c', yaml: '- launchApp' });
      expect(exit).to.equal(0);
      expect(polls).to.equal(2);
    });

    it('run keeps the command id when it has to give up asking', async () => {
      deviceTiming.retryMs = 0;
      stubFetch((call) => (call.method === 'POST' ? running() : { status: 502, body: { message: 'Application failed to respond' } }));
      const { exit, out } = await runJson('run', { id: 'a-b-c', yaml: '- launchApp' });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      expect(out.error).to.include({ command_id: 'c1' });
      expect((out.error as { message: string }).message).to.include('may still be running on a-b-c: its command id is c1');
    });

    it('start --wait --json names the session on stderr as soon as it exists', async () => {
      let polls = 0;
      stubFetch((call) => {
        if (call.method === 'POST') return { body: { session: session('a-b-c', { state: 'queued' }) } };
        polls += 1;
        return { body: { session: session('a-b-c', { state: polls < 2 ? 'provisioning' : 'ready' }) } };
      });
      const { result, stderr } = await captureStderr(() => runJson('start', { platform: 'ios', wait: true }));
      expect(result.exit).to.equal(0);
      expect(stderr).to.include('Session a-b-c started');
      expect(stderr).to.include('dcd device stop a-b-c');
    });

    it('status --wait waits for the device and its app, and exits 4 when the session ends instead', async () => {
      let polls = 0;
      stubFetch((call) => {
        if (call.url.endsWith('/human')) return { status: 404, body: { statusCode: 404, message: 'Not Found' } };
        polls += 1;
        const install = { binary_upload_id: 'b1', error: null, status: polls < 3 ? ('installing' as const) : ('installed' as const) };
        return { body: { session: session('a-b-c', { state: polls < 2 ? 'provisioning' : 'ready', install }) } };
      });
      const ready = await runJson('status', { id: 'a-b-c', wait: true });
      expect(ready.exit).to.equal(0);
      expect((ready.out.session as DeviceSession).install!.status).to.equal('installed');

      stubFetch(() => ({ body: { session: session('a-b-c', { state: 'expired', release_reason: 'max_duration' }) } }));
      const ended = await runJson('status', { id: 'a-b-c', wait: true });
      expect(ended.exit).to.equal(DEVICE_EXIT.gone);
    });
  });

  describe('flows that use other files', () => {
    it('run <file> uploads the flow with the files it uses, and runs it by its path inside', async () => {
      const flows = path.join(tempDir, 'flows');
      fs.mkdirSync(path.join(flows, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(flows, 'sub', 'login.yaml'), 'appId: x\n---\n- launchApp\n');
      fs.writeFileSync(path.join(flows, 'main.yaml'), 'appId: x\n---\n- runFlow: sub/login.yaml\n');
      fs.writeFileSync(path.join(flows, 'other.yaml'), 'appId: x\n---\n- back\n');
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
      const { exit } = await runJson('run', { id: 'a-b-c', flow: path.join(flows, 'main.yaml'), env: ['A=1'] });
      expect(exit).to.equal(0);
      expect(calls.find((c) => c.url.endsWith('/run'))!.body).to.deep.equal({
        flowUploadId: 'b-1',
        flow: 'main.yaml',
        env: { A: '1' },
      });
    });

    it('run --env-file reads KEY=VALUE lines, and --env wins for the same name', async () => {
      const envFile = path.join(tempDir, '.env');
      fs.writeFileSync(envFile, '# test account\nexport USER=me\nPASS="p a s s"\n\nSAME=file\n');
      const calls = stubFetch(() => ({
        body: { command_id: 'c1', status: 'passed', result: { success: true }, session: session('a-b-c') },
      }));
      await runJson('run', { id: 'a-b-c', yaml: '- launchApp', 'env-file': envFile, env: ['SAME=flag'] });
      expect((calls[0].body as { env: Record<string, string> }).env).to.deep.equal({
        USER: 'me',
        PASS: 'p a s s',
        SAME: 'flag',
      });
    });

    it('parseEnvFile names a bad line by number only, since it may hold a secret', () => {
      const envFile = path.join(tempDir, 'bad.env');
      fs.writeFileSync(envFile, 'GOOD=1\nhunter2\n');
      expect(() => parseEnvFile(envFile)).to.throw(/line 2: expected KEY=VALUE/);
      expect(() => parseEnvFile(envFile)).not.to.throw(/hunter2/);
      expect(() => parseEnvFile(path.join(tempDir, 'missing.env'))).to.throw(/Could not read --env-file/);
    });
  });

  describe('what a person reads', () => {
    it('an action prints the session warnings after its result', async () => {
      stubFetch(() => ({
        body: {
          result: { success: true },
          session: session('a-b-c', { warnings: ['Idle timeout in 40s. Send a command to keep the session, or stop it if you are done.'] }),
        },
      }));
      const out = await runText('tap', { id: 'a-b-c', text: 'OK' });
      expect(out).to.include('Tapped "OK"');
      expect(out).to.include('Idle timeout in 40s');
    });

    it("a failed action's message never carries the typed text", async () => {
      stubFetch(() => ({ body: { result: { success: false }, session: session('a-b-c') } }));
      const { exit, out } = await runJson('type', { id: 'a-b-c', text: 'hunter2' });
      expect(exit).to.equal(DEVICE_EXIT.failed);
      expect(out.error).to.deep.equal({ code: null, message: 'Typing failed.' });
    });

    it('strips escape sequences and control characters from device text', () => {
      const hostile = `${ESC}]0;pwned${BEL}Hello${ESC}[2K${CR}World ${String.fromCharCode(0x202e)}gnp.exe`;
      expect(printable(hostile)).to.equal('HelloWorld gnp.exe');
      expect(printable('a\nb\tc', { oneLine: true })).to.equal('a b c');
      const element = formatElement({ b: '[0,0][1,1]', txt: `${ESC}[31mRed${ESC}[0m`, hint: `x${CR}y` });
      // Only the CLI's own styling is left.
      expect(element).not.to.include(`${ESC}[31m`);
      expect(element).not.to.include(CR);
      expect(stripVTControlCharacters(element)).to.include('"Red"');
    });

    it('logs strips escapes from each line, and says when the size cap cut the answer', async () => {
      stubFetch(() => ({
        body: {
          logs: { lines: [`${ESC}]0;title${BEL}E crash here`], source: 'logcat', app_id: 'com.x', truncated: true },
          session: session('a-b-c'),
        },
      }));
      const out = await runText('logs', { id: 'a-b-c', lines: '200' });
      expect(out).not.to.include(ESC);
      expect(out).to.include('E crash here');
      expect(out).to.include('Only the newest lines that fit in 24 KB are shown');
    });

    it('logs passes on --level and --grep, and refuses a level it does not know', async () => {
      const calls = stubFetch(() => ({
        body: { logs: { lines: [], source: 'logcat', app_id: 'com.x' }, session: session('a-b-c') },
      }));
      await runJson('logs', { id: 'a-b-c', lines: '50', level: 'error', grep: ' NullPointer ' });
      expect(calls[0].url).to.equal(`${API}/device/sessions/a-b-c/logs?lines=50&level=error&grep=NullPointer`);
      const { exit } = await runJson('logs', { id: 'a-b-c', level: 'debug' });
      expect(exit).to.equal(DEVICE_EXIT.usage);
    });

    it('status says a person has control once, as the API now words it', async () => {
      const warning = 'A person has control: a@b.c took control. The session ends in 900s unless they hand it back.';
      stubFetch((call) =>
        call.url.endsWith('/human')
          ? {
              body: {
                human: {
                  waiting: true,
                  reason: 'a@b.c took control',
                  since: null,
                  expires_at: null,
                  handed_back: false,
                  note: null,
                  handed_back_at: null,
                  human_in_control: true,
                  controller_user_id: 'u1',
                },
                session: session('a-b-c', { state: 'needs_human' }),
              },
            }
          : { body: { session: session('a-b-c', { state: 'needs_human', warnings: [warning] }) } },
      );
      const out = await runText('status', { id: 'a-b-c' });
      expect(out.split('A person has control')).to.have.length(2);
    });

    it('formatCost shows the half cent a 30-second unit leaves', () => {
      expect(formatCost(0.015)).to.equal('$0.015');
      expect(formatCost(0.045)).to.equal('$0.045');
      expect(formatCost(0.42)).to.equal('$0.42');
      expect(formatCost(1.8)).to.equal('$1.80');
      expect(formatCost(0)).to.equal('$0.00');
    });
  });

  describe('smaller things', () => {
    it('start refuses an empty --app (an unset variable), without starting a session', async () => {
      const calls = stubFetch(() => ({ body: {} }));
      for (const args of [{ app: '' }, { app: '  ' }, { 'app-binary-id': '' }]) {
        const { exit, out } = await runJson('start', { platform: 'ios', ...args });
        expect(exit).to.equal(DEVICE_EXIT.usage);
        expect((out.error as { message: string }).message).to.include('is empty');
      }

      expect(calls).to.have.length(0);
    });

    it('start --app <url> takes the platform from the file name in the link', async () => {
      const calls = stubFetch((call) =>
        call.url.endsWith('/install')
          ? { body: { app: { app_id: 'com.x', binary_upload_id: 'b1', reused: false }, session: session('a-b-c') } }
          : { body: { session: session('a-b-c', { state: 'queued' }) } },
      );
      const { exit } = await runJson('start', { app: 'https://ci.example.com/builds/app-release.apk?token=x' });
      expect(exit).to.equal(0);
      expect((calls[0].body as { platform: string }).platform).to.equal('android');
      expect(platformOfAppUrl('https://x.example/My%20App.zip')).to.equal('ios');
      expect(platformOfAppUrl('https://x.example/download?id=1')).to.equal(undefined);
    });

    it('swipe and tap take points written with a percent sign', async () => {
      const calls = stubFetch(() => ({ body: { result: { success: true }, session: session('a-b-c') } }));
      await runJson('swipe', { id: 'a-b-c', from: '50%,80%', to: '50%, 20%' });
      expect(calls[0].body).to.deep.equal({ type: 'swipe', from: { x: 50, y: 80 }, to: { x: 50, y: 20 } });
      await runJson('tap', { id: 'a-b-c', x: '10%', y: '90' });
      expect(calls[1].body).to.deep.equal({ type: 'tap', x: 10, y: 90 });
    });

    it('request-human takes --reason, so the session id may come first', async () => {
      const calls = stubFetch(() => ({
        body: {
          human: {
            waiting: true,
            reason: 'Enter the code',
            since: null,
            expires_at: null,
            handed_back: false,
            note: null,
            handed_back_at: null,
            human_in_control: false,
            controller_user_id: null,
          },
          session: session('a-b-c', { state: 'needs_human' }),
        },
      }));
      const { exit } = await runArgv(['request-human', 'a-b-c', '--reason', 'Enter the code']);
      expect(exit).to.equal(0);
      expect(calls).to.have.length(1);
      expect(calls[0].url).to.equal(`${API}/device/sessions/a-b-c/request-human`);
      expect(calls[0].body).to.deep.equal({ reason: 'Enter the code' });
    });

    it("request-human refuses a lone argument that is an open session's id", async () => {
      const calls = stubFetch(() => ({ body: { sessions: [session('a-b-c')] } }));
      const { exit, out } = await runArgv(['request-human', 'a-b-c']);
      expect(exit).to.equal(DEVICE_EXIT.usage);
      expect((out.error as { message: string }).message).to.include('is a session id, not what the person should do');
      expect(calls.map((c) => c.method)).to.deep.equal(['GET']);
    });

    it('artifacts with no id takes your newest session, even one that has ended', async () => {
      const mine = (id: string, created: string) =>
        session(id, {
          state: 'released',
          created_at: created,
          started_by: { api_key_name: null, client_label: null, email: null, this_client: false, you: true },
        });
      const theirs = session('their-new-one', {
        created_at: '2026-10-19T12:00:00Z',
        started_by: { api_key_name: null, client_label: null, email: 'ann@example.com', this_client: false, you: false },
      });
      const calls = stubFetch((call) =>
        call.url.includes('/artifacts')
          ? { body: { actions: [], logs: null, recording: null, next_before: null, session: session('my-newer-one') } }
          : { body: { sessions: [theirs, mine('my-old-one', '2026-10-19T09:00:00Z'), mine('my-newer-one', '2026-10-19T11:00:00Z')] } },
      );
      const { exit } = await runJson('artifacts', { links: true });
      expect(exit).to.equal(0);
      expect(calls[0].url).to.equal(`${API}/device/sessions?all=true`);
      expect(calls[1].url).to.include('/device/sessions/my-newer-one/artifacts');
    });

    it('readStdinText reads piped text without its last line break, and refuses a terminal', async () => {
      expect(await readStdinText(Readable.from([Buffer.from('s3cret\n')]))).to.equal('s3cret');
      const terminal = Object.assign(Readable.from([]), { isTTY: true });
      try {
        await readStdinText(terminal);
        expect.fail('should have thrown');
      } catch (error) {
        expect((error as Error).message).to.include('pipe it in');
      }
    });

    it('type refuses --text with --text-stdin', async () => {
      const calls = stubFetch(() => ({ body: {} }));
      const { exit } = await runJson('type', { id: 'a-b-c', text: 'x', 'text-stdin': true });
      expect(exit).to.equal(DEVICE_EXIT.usage);
      expect(calls).to.have.length(0);
    });
  });
});
