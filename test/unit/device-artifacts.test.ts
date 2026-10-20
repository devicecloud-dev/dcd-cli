import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DeviceArtifactsPage, DeviceSession } from '../../src/types/domain/device-session.types.js';
import {
  downloadArtifactFiles,
  fetchAllArtifacts,
  planArtifactFiles,
} from '../../src/utils/device-artifacts.js';

const API = 'https://api.devicecloud.dev';
const auth = { headers: {}, mode: 'apiKey' as const };
const session = { id: 'a-b-c', state: 'released' } as DeviceSession;

const link = (url: null | string, contentType: string) => ({
  url,
  content_type: contentType,
  bytes: 3,
  created_at: '2026-10-19T10:00:00Z',
});

function page(extra: Partial<DeviceArtifactsPage>): DeviceArtifactsPage {
  return { actions: [], logs: null, next_before: null, recording: null, session, ...extra };
}

describe('dcd device artifacts', () => {
  const realFetch = globalThis.fetch;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-artifacts-test-'));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it('follows next_before through every page', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      const body = String(input).includes('before=')
        ? page({ actions: [{ command_id: 'c1', created_at: 't1', screenshot: null, hierarchy: null }] })
        : page({
            next_before: '2026-10-19T10:00:00Z',
            actions: [{ command_id: 'c2', created_at: 't2', screenshot: null, hierarchy: null }],
          });
      return new Response(JSON.stringify(body));
    }) as typeof fetch;

    const { pages } = await fetchAllArtifacts(API, auth, 'a-b-c');
    expect(pages).to.have.length(2);
    expect(urls).to.deep.equal([
      `${API}/device/sessions/a-b-c/artifacts?limit=200`,
      `${API}/device/sessions/a-b-c/artifacts?limit=200&before=2026-10-19T10%3A00%3A00Z`,
    ]);
  });

  it('names the files, numbering actions oldest first', () => {
    const files = planArtifactFiles([
      page({
        recording: link('https://r', 'video/mp4'),
        logs: link('https://l', 'text/plain; charset=utf-8'),
        actions: [
          { command_id: 'c2', created_at: 't2', screenshot: link('https://s2', 'image/jpeg'), hierarchy: null },
        ],
      }),
      page({
        actions: [
          {
            command_id: 'c1',
            created_at: 't1',
            screenshot: link('https://s1', 'image/jpeg'),
            hierarchy: link('https://h1', 'application/json'),
          },
        ],
      }),
    ]);
    expect(files.map((f) => [f.file, f.command_id ?? null])).to.deep.equal([
      ['recording.mp4', null],
      ['device.log', null],
      [path.join('actions', '001-screenshot.jpg'), 'c1'],
      [path.join('actions', '001-screen.json'), 'c1'],
      [path.join('actions', '002-screenshot.jpg'), 'c2'],
    ]);
  });

  it('downloads what it can and reports the rest', async () => {
    globalThis.fetch = (async (input: unknown) =>
      String(input) === 'https://ok'
        ? new Response('abc')
        : new Response('gone', { status: 404 })) as typeof fetch;

    const failed = await downloadArtifactFiles(tempDir, [
      { kind: 'recording', file: 'recording.mp4', url: 'https://ok', bytes: 3, created_at: 't' },
      { kind: 'logs', file: 'device.log', url: 'https://missing', bytes: 3, created_at: 't' },
      { kind: 'screenshot', file: path.join('actions', '001-screenshot.jpg'), url: null, bytes: null, created_at: 't' },
    ]);
    expect(fs.readFileSync(path.join(tempDir, 'recording.mp4'), 'utf8')).to.equal('abc');
    expect(failed.map((f) => f.file).sort()).to.deep.equal(
      [path.join('actions', '001-screenshot.jpg'), 'device.log'].sort(),
    );
  });
  /** A response whose body never sends a byte, and never closes. */
  const stalled = () => new Response(new ReadableStream({ start() {} }));

  it('reports a stalled download as timed out instead of hanging', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return stalled();
    }) as typeof fetch;

    const started = Date.now();
    const failed = await downloadArtifactFiles(
      tempDir,
      [{ kind: 'logs', file: 'device.log', url: 'https://stalls', bytes: 3, created_at: 't' }],
      undefined,
      { idleTimeoutMs: 50 },
    );
    expect(Date.now() - started).to.be.lessThan(2000);
    expect(calls).to.equal(2);
    expect(failed).to.have.length(1);
    expect(failed[0].file).to.equal('device.log');
    expect(failed[0].reason).to.match(/timed out: no data for 50ms/);
    expect(fs.existsSync(path.join(tempDir, 'device.log'))).to.equal(false);
  });

  it('times out a download that is slow overall', async () => {
    let tick: NodeJS.Timeout | undefined;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          // A trickle: data keeps arriving, but the file never finishes.
          start(controller) {
            tick = setInterval(() => controller.enqueue(new Uint8Array([1])), 10);
          },
          cancel() {
            clearInterval(tick);
          },
        }),
      )) as typeof fetch;

    const failed = await downloadArtifactFiles(
      tempDir,
      [{ kind: 'logs', file: 'device.log', url: 'https://trickle', bytes: 3, created_at: 't' }],
      undefined,
      { attempts: 1, idleTimeoutMs: 500, totalTimeoutMs: 100 },
    );
    clearInterval(tick);
    expect(failed.map((f) => f.reason)).to.deep.equal(['timed out: took longer than 100ms']);
  });

  it('retries a failed download once', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return calls.length === 1 ? stalled() : new Response('log line');
    }) as typeof fetch;

    const saved: string[] = [];
    const failed = await downloadArtifactFiles(
      tempDir,
      [{ kind: 'logs', file: 'device.log', url: 'https://flaky', bytes: 8, created_at: 't' }],
      (f) => saved.push(f.file),
      { idleTimeoutMs: 50 },
    );
    expect(failed).to.deep.equal([]);
    expect(calls).to.have.length(2);
    expect(saved).to.deep.equal(['device.log']);
    expect(fs.readFileSync(path.join(tempDir, 'device.log'), 'utf8')).to.equal('log line');
  });
});
