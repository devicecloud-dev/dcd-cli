import { expect } from 'chai';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ApiGateway, type ResultsPollCache } from '../../src/gateways/api-gateway.js';
import { ResultsPollingService } from '../../src/services/results-polling.service.js';
import type { AuthContext } from '../../src/types/domain/auth.types.js';

/**
 * `dcd cloud` polls `GET /results/:uploadId` every 20-60s for the whole run.
 * It asks for the slim `?view=summary` rows and revalidates with an ETag, so
 * a poll that finds nothing changed costs an empty 304.
 *
 * These run against a real HTTP server with the real global fetch, because
 * the header that makes the 304 possible at all (`cache-control: max-age=0`)
 * only matters to undici: without it, undici appends `Cache-Control:
 * no-cache` to the conditional request and Express never answers 304.
 */

const AUTH: AuthContext = { mode: 'apiKey', headers: { 'x-app-api-key': 'k' } };

type Reply = { body?: unknown; etag?: string; status?: number };
type Seen = { headers: http.IncomingHttpHeaders; url: string };

let server: http.Server;
let baseUrl: string;
let replies: Reply[];
let seen: Seen[];

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  test_file_name: 'flows/login.yaml',
  status: 'RUNNING',
  retry_of: null,
  duration_seconds: null,
  fail_reason: null,
  cancellation_reason: null,
  simulator_name: 'pixel-7',
  config: { deviceName: 'Pixel 7', osVersion: '34' },
  ...overrides,
});

const get = (cache?: ResultsPollCache) =>
  ApiGateway.getResultsForUpload(baseUrl, AUTH, 'u1', cache);

describe('results poll: summary view and ETag revalidation', () => {
  before(async () => {
    server = http.createServer((req, res) => {
      seen.push({ headers: req.headers, url: req.url ?? '' });
      const reply = replies.shift() ?? { status: 500, body: { message: 'no reply queued' } };
      const status = reply.status ?? 200;
      if (reply.etag) res.setHeader('etag', reply.etag);
      if (status === 304) {
        res.writeHead(304).end();
        return;
      }

      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    replies = [];
    seen = [];
  });

  describe('ApiGateway.getResultsForUpload', () => {
    it('asks for the summary view, unconditionally, on the first poll', async () => {
      const body = { results: [row()] };
      replies.push({ body, etag: 'W/"a"' });
      const cache: ResultsPollCache = {};

      expect(await get(cache)).to.deep.equal(body);

      expect(seen[0].url).to.equal('/results/u1?view=summary');
      expect(seen[0].headers['x-app-api-key']).to.equal('k');
      expect(seen[0].headers).to.not.have.property('if-none-match');
      expect(cache).to.deep.equal({ body, etag: 'W/"a"' });
    });

    it('revalidates with If-None-Match and max-age=0, not no-cache', async () => {
      const body = { results: [row()] };
      replies.push({ body, etag: 'W/"a"' }, { status: 304, etag: 'W/"a"' });
      const cache: ResultsPollCache = {};

      await get(cache);
      const second = await get(cache);

      expect(seen[1].url).to.equal('/results/u1?view=summary');
      expect(seen[1].headers['if-none-match']).to.equal('W/"a"');
      // undici would append `no-cache` here, which Express's `fresh` reads as
      // "never 304". The explicit header keeps it out.
      expect(seen[1].headers['cache-control']).to.equal('max-age=0');
      expect(second).to.deep.equal(body);
      expect(cache.etag).to.equal('W/"a"');
    });

    it('replaces the cache when the results changed', async () => {
      const before = { results: [row()] };
      const after = { results: [row({ status: 'PASSED', duration_seconds: 12 })] };
      replies.push({ body: before, etag: 'W/"a"' }, { body: after, etag: 'W/"b"' });
      const cache: ResultsPollCache = {};

      await get(cache);
      expect(await get(cache)).to.deep.equal(after);

      expect(seen[1].headers['if-none-match']).to.equal('W/"a"');
      expect(cache).to.deep.equal({ body: after, etag: 'W/"b"' });
    });

    const uncacheable: Array<[string, Reply]> = [
      ['a 200 with no ETag', { body: { results: [row()] } }],
      ['an empty result set', { body: { results: [] }, etag: 'W/"e"' }],
      [
        'the error envelope the API sends as a 200',
        { body: { statusCode: 400, message: 'Upload not found' }, etag: 'W/"x"' },
      ],
    ];

    for (const [name, reply] of uncacheable) {
      it(`does not cache ${name}, so the next poll is unconditional`, async () => {
        // Start from a cached set, so this also shows the cache is cleared
        // rather than left holding the previous body.
        replies.push({ body: { results: [row()] }, etag: 'W/"a"' }, reply, {
          body: { results: [row()] },
          etag: 'W/"a"',
        });
        const cache: ResultsPollCache = {};

        await get(cache);
        expect(await get(cache)).to.deep.equal(reply.body);
        expect(cache).to.deep.equal({});
        await get(cache);

        expect(seen[1].headers['if-none-match']).to.equal('W/"a"');
        expect(seen[2].headers).to.not.have.property('if-none-match');
        expect(seen[2].headers['cache-control']).to.not.equal('max-age=0');
      });
    }

    it('throws on a 304 it did not ask for, and clears the cache', async () => {
      replies.push({ status: 304, etag: 'W/"a"' });
      // An ETag with no body to go with it is not enough to revalidate.
      const cache: ResultsPollCache = { etag: 'W/"stale"' };

      let caught: unknown;
      try {
        await get(cache);
      } catch (error) {
        caught = error;
      }

      expect(seen[0].headers).to.not.have.property('if-none-match');
      expect(caught).to.be.instanceOf(Error);
      expect((caught as Error).message).to.include('304');
      expect(cache).to.deep.equal({});
    });

    it('still polls the summary view without a cache', async () => {
      const body = { results: [row()] };
      replies.push({ body, etag: 'W/"a"' }, { body, etag: 'W/"a"' });

      await get();
      expect(await get()).to.deep.equal(body);

      expect(seen.map((s) => s.url)).to.deep.equal([
        '/results/u1?view=summary',
        '/results/u1?view=summary',
      ]);
      expect(seen[1].headers).to.not.have.property('if-none-match');
    });
  });

  describe('poll loop', () => {
    it('treats a 304 as a successful poll and finishes on the next change', async () => {
      replies.push(
        { body: { results: [row()] }, etag: 'W/"a"' },
        { status: 304, etag: 'W/"a"' },
        { body: { results: [row({ status: 'PASSED', duration_seconds: 9 })] }, etag: 'W/"b"' },
      );
      const service = new ResultsPollingService();
      // Poll back to back instead of every 20s.
      (service as unknown as { APIKEY_POLL_INTERVAL_MS: number }).APIKEY_POLL_INTERVAL_MS = 0;
      const logs: string[] = [];

      const result = await service.pollUntilComplete({
        auth: AUTH,
        apiUrl: baseUrl,
        consoleUrl: 'https://console.example.com/results?upload=u1',
        debug: true,
        json: true,
        logger: (m) => logs.push(m),
        uploadId: 'u1',
      });

      expect(result.status).to.equal('PASSED');
      expect(result.tests[0]).to.include({ durationSeconds: 9, status: 'PASSED' });
      expect(seen.map((s) => s.headers['if-none-match'])).to.deep.equal([
        undefined,
        'W/"a"',
        'W/"a"',
      ]);
      expect(logs).to.include('[DEBUG] Poll not modified (304), reusing 1 cached results');
      expect(logs.some((m) => m.includes('unable to fetch results'))).to.equal(false);
    });
  });

  describe('buildPollingResult', () => {
    // buildPollingResult is private; reach it rather than re-implementing the
    // verdict, as superseded-run.test.ts does.
    const build = (results: unknown[]) =>
      (
        new ResultsPollingService() as unknown as {
          buildPollingResult: (
            r: unknown[],
            uploadId: string,
            consoleUrl: string,
            testMetadata?: Record<string, { flowName: string; tags: string[] }>,
          ) => unknown;
        }
      ).buildPollingResult(results, 'u1', 'https://console/u1', {
        'flows/login.yaml': { flowName: 'Login', tags: ['smoke'] },
      });

    // What the default view sends: every column, the whole config, and the
    // result_files row with its main_log.
    const full = (overrides: Record<string, unknown> = {}) => ({
      test_name: null,
      created_at: '2026-10-07T10:00:00.000Z',
      platform: 'android',
      result_files: {
        id: 9,
        main_log: 'x'.repeat(10_000),
        screenshots: ['a.png', 'b.png'],
      },
      ...row({
        config: { deviceName: 'Pixel 7', osVersion: '34', orientation: 'portrait', retries: 1 },
        ...overrides,
      }),
    });

    // What `?view=summary` sends: only the columns the CLI reads, with
    // config cut down to deviceName/osVersion and null keys left out.
    const summary = (overrides: Record<string, unknown> = {}) => {
      const {
        config,
        created_at: _at,
        platform: _platform,
        result_files: _files,
        test_name: _name,
        ...kept
      } = full(overrides);
      const { deviceName, osVersion } = config as { deviceName?: unknown; osVersion?: unknown };
      return {
        ...kept,
        config: {
          ...(deviceName == null ? {} : { deviceName }),
          ...(osVersion == null ? {} : { osVersion }),
        },
      };
    };

    const runs: Array<[string, Array<Record<string, unknown>>]> = [
      [
        'a failed run with a retry',
        [
          { id: 1, status: 'FAILED', fail_reason: 'Element not found', duration_seconds: 30 },
          { id: 2, status: 'PASSED', retry_of: 1, duration_seconds: 25 },
          {
            // A row from before per-result device config: the device falls
            // back to simulator_name.
            id: 3,
            test_file_name: 'flows/checkout.yaml',
            status: 'FAILED',
            fail_reason: 'Timed out',
            duration_seconds: 60,
            config: { orientation: 'portrait' },
            simulator_name: 'pixel-7_PLAY',
          },
          {
            // `config->osVersion` keeps a numeric osVersion numeric.
            id: 4,
            test_file_name: 'flows/search.yaml',
            status: 'PASSED',
            duration_seconds: 5,
            config: { deviceName: 'iPhone 15', osVersion: 17, orientation: 'portrait' },
            simulator_name: 'iphone-15-17',
          },
        ],
      ],
      [
        'a superseded run',
        [
          { id: 1, status: 'PASSED', duration_seconds: 10 },
          { id: 2, status: 'CANCELLED', cancellation_reason: 'superseded_by:newer-upload' },
        ],
      ],
    ];

    for (const [name, overrides] of runs) {
      it(`gives the same result for full and summary rows: ${name}`, () => {
        const fromFull = build(overrides.map((o) => full(o)));
        const fromSummary = build(overrides.map((o) => summary(o)));

        expect((fromFull as { tests: unknown[] }).tests).to.not.be.empty;
        expect(fromSummary).to.deep.equal(fromFull);
      });
    }
  });
});
