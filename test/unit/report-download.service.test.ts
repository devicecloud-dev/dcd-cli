import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ApiGateway } from '../../src/gateways/api-gateway.js';
import {
  downloadsSucceeded,
  matchFlowResult,
  ReportDownloadService,
  reportFormatDeprecation,
} from '../../src/services/report-download.service.js';
import {
  type BundleFallbackTelemetry,
  telemetry,
} from '../../src/services/telemetry.service.js';
import type { AuthContext } from '../../src/types/domain/auth.types.js';
import { zipBuffer } from '../helpers/zip-fixture.js';

const TEST_AUTH: AuthContext = {
  mode: 'apiKey',
  headers: { 'x-app-api-key': 'test-key' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CapturedRequest = {
  body: null | string;
  headers: Record<string, string>;
  method: string;
  url: string;
};

let captured: CapturedRequest | null = null;

// Artifact and HTML report downloads are checked for a complete ZIP, so they
// are served real ones. Two, with different contents, so a test can tell which
// path wrote the file.
let INLINE_ZIP: Buffer;
let BUNDLE_ZIP: Buffer;

before(async () => {
  INLINE_ZIP = await zipBuffer(20, 4096, 1);
  BUNDLE_ZIP = await zipBuffer(20, 4096, 2);
});

/** `zip` cut off before its central directory, as a dropped stream leaves it. */
const truncated = (zip: Buffer) => zip.subarray(0, Math.floor(zip.length / 2));
const originalFetch = (global as any).fetch;

/**
 * Replace global.fetch with a mock that records what it was called with and
 * returns the given status + body content. The body is served as a
 * ReadableStream so that Readable.fromWeb() in the gateway can consume it.
 * @param status HTTP status code to return
 * @param responseBody Response body string
 * @returns void
 */
function mockFetch(status: number, responseBody?: Buffer | string) {
  const encoder = new TextEncoder();
  // Default: a complete ZIP, the body a successful artifacts download has.
  const body = responseBody ?? INLINE_ZIP;
  (global as any).fetch = async (
    input: URL | string,
    init?: RequestInit,
  ): Promise<Response> => {
    captured = {
      body: init?.body ? String(init.body) : null,
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      ),
      method: (init?.method ?? 'GET').toUpperCase(),
      url: input.toString(),
    };

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          typeof body === 'string' ? encoder.encode(body) : new Uint8Array(body),
        );
        controller.close();
      },
    });

    return new Response(stream, { status });
  };
}

function restoreFetch() {
  (global as any).fetch = originalFetch;
  captured = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReportDownloadService', () => {
  let service: ReportDownloadService;
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-unit-test-'));
  });

  after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }

    restoreFetch();
  });

  beforeEach(() => {
    service = new ReportDownloadService();
    captured = null;
  });

  afterEach(() => {
    restoreFetch();
  });

  // -------------------------------------------------------------------------
  // downloadArtifacts
  // -------------------------------------------------------------------------

  describe('downloadArtifacts', () => {
    const BASE = {
      auth: TEST_AUTH,
      apiUrl: 'https://api.example.com',
      uploadId: 'upload-abc-123',
    };

    it('calls POST /results/{uploadId}/download with correct headers and body for FAILED', async () => {
      const outPath = path.join(tempDir, 'artifacts-failed.zip');
      mockFetch(200);

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'FAILED',
      });

      expect(captured).to.not.be.null;
      expect(captured!.url).to.equal(
        `https://api.example.com/results/upload-abc-123/download`,
      );
      expect(captured!.method).to.equal('POST');
      expect(captured!.headers['x-app-api-key']).to.equal('test-key');
      expect(captured!.headers['content-type']).to.equal('application/json');
      expect(JSON.parse(captured!.body!)).to.deep.equal({ results: 'FAILED' });
    });

    it('calls POST /results/{uploadId}/download with body results: ALL', async () => {
      const outPath = path.join(tempDir, 'artifacts-all.zip');
      mockFetch(200);

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(JSON.parse(captured!.body!)).to.deep.equal({ results: 'ALL' });
    });

    it('writes the response body to the specified file path', async () => {
      const outPath = path.join(tempDir, 'written.zip');
      mockFetch(200, INLINE_ZIP);

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(fs.existsSync(outPath)).to.be.true;
      expect(fs.readFileSync(outPath).equals(INLINE_ZIP)).to.be.true;
    });

    it('creates intermediate directories if they do not exist', async () => {
      const outPath = path.join(tempDir, 'nested', 'dir', 'artifacts.zip');
      mockFetch(200);

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(fs.existsSync(outPath)).to.be.true;
    });

    it('calls warnLogger and does not throw on API error', async () => {
      const outPath = path.join(tempDir, 'should-not-exist.zip');
      mockFetch(403, JSON.stringify({ message: 'Forbidden' }));

      const warnings: string[] = [];

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'FAILED',
        warnLogger: (msg) => warnings.push(msg),
      });

      expect(warnings).to.have.length.greaterThan(0);
      expect(warnings.join(' ')).to.match(/failed to download artifacts/i);
      expect(fs.existsSync(outPath)).to.be.false;
    });

    it('calls logger with success message when download succeeds', async () => {
      const outPath = path.join(tempDir, 'logged.zip');
      mockFetch(200);

      const logs: string[] = [];

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
        logger: (msg) => logs.push(msg),
      });

      expect(logs.join(' ')).to.include(outPath);
    });

    // `dcd artifacts --json` reports these, since failures only warn.
    it('returns ok: true with the path when the download succeeds', async () => {
      const outPath = path.join(tempDir, 'result-ok.zip');
      mockFetch(200);

      const result = await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(result).to.deep.equal({ ok: true, path: outPath, type: 'artifacts' });
    });

    it('returns ok: false with the error when the download fails', async () => {
      const outPath = path.join(tempDir, 'result-fail.zip');
      mockFetch(404, 'not found');

      const result = await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(result.ok).to.equal(false);
      expect(result.type).to.equal('artifacts');
      expect(result.error).to.be.a('string').and.not.be.empty;
    });

    describe('an inline download that ends early', () => {
      let incomplete: Array<{ bytes: number; route: string; upload_id?: string }>;
      const realRecordDownloadIncomplete = telemetry.recordDownloadIncomplete;

      beforeEach(() => {
        incomplete = [];
        telemetry.recordDownloadIncomplete = (detail) => {
          incomplete.push(detail);
        };
      });

      afterEach(() => {
        telemetry.recordDownloadIncomplete = realRecordDownloadIncomplete;
      });

      it('fails, deletes the partial ZIP and records it', async () => {
        const outPath = path.join(tempDir, 'cut-inline.zip');
        const cut = truncated(INLINE_ZIP);
        mockFetch(200, cut);
        const warnings: string[] = [];

        const result = await service.downloadArtifacts({
          ...BASE,
          artifactsPath: outPath,
          downloadType: 'ALL',
          warnLogger: (msg) => warnings.push(msg),
        });

        expect(result.ok).to.equal(false);
        expect(result.error).to.include('the download ended early');
        expect(result.error).to.include(`${cut.length} bytes`);
        expect(warnings.join(' ')).to.match(/failed to download artifacts/i);
        expect(fs.existsSync(outPath)).to.be.false;
        expect(incomplete).to.deep.equal([
          { bytes: cut.length, route: 'download', upload_id: 'upload-abc-123' },
        ]);
      });

      it('fails an HTML report ZIP that ends early', async () => {
        const outPath = path.join(tempDir, 'cut-report.zip');
        mockFetch(200, truncated(INLINE_ZIP));

        const result = await service.downloadReports({
          ...BASE,
          htmlPath: outPath,
          reportType: 'html',
        });

        expect(result?.ok).to.equal(false);
        expect(fs.existsSync(outPath)).to.be.false;
        expect(incomplete[0]).to.include({ route: 'html-report' });
      });

      it('never checks a JUnit or Allure report, which are not ZIPs', async () => {
        for (const [reportType, file, body] of [
          ['junit', 'not-zip.xml', '<xml/>'],
          ['allure', 'not-zip.html', '<html/>'],
        ] as const) {
          const outPath = path.join(tempDir, file);
          mockFetch(200, body);

          const result = await service.downloadReports({
            ...BASE,
            allurePath: outPath,
            junitPath: outPath,
            reportType,
          });

          expect(result?.ok, reportType).to.equal(true);
          expect(fs.readFileSync(outPath, 'utf8')).to.equal(body);
        }

        expect(incomplete).to.deep.equal([]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // downloadReports — endpoint routing
  // -------------------------------------------------------------------------

  describe('downloadReports endpoint routing', () => {
    const BASE = {
      auth: TEST_AUTH,
      apiUrl: 'https://api.example.com',
      uploadId: 'upload-xyz-456',
    };

    it('uses GET /results/{uploadId}/report for junit', async () => {
      const outPath = path.join(tempDir, 'report.xml');
      mockFetch(200, '<xml/>');

      await service.downloadReports({
        ...BASE,
        junitPath: outPath,
        reportType: 'junit',
      });

      expect(captured!.method).to.equal('GET');
      expect(captured!.url).to.equal(
        'https://api.example.com/results/upload-xyz-456/report',
      );
      expect(fs.readFileSync(outPath, 'utf8')).to.equal('<xml/>');
    });

    it('uses GET /allure/{uploadId}/download for allure', async () => {
      const outPath = path.join(tempDir, 'allure.html');
      mockFetch(200, '<html/>');

      await service.downloadReports({
        ...BASE,
        allurePath: outPath,
        reportType: 'allure',
      });

      expect(captured!.url).to.equal(
        'https://api.example.com/allure/upload-xyz-456/download',
      );
      expect(fs.readFileSync(outPath, 'utf8')).to.equal('<html/>');
    });

    it('uses GET /results/{uploadId}/html-report for html', async () => {
      const outPath = path.join(tempDir, 'html.html');
      mockFetch(200, INLINE_ZIP);

      await service.downloadReports({
        ...BASE,
        htmlPath: outPath,
        reportType: 'html',
      });

      expect(captured!.url).to.equal(
        'https://api.example.com/results/upload-xyz-456/html-report',
      );
    });

    it('sends x-app-api-key header', async () => {
      const outPath = path.join(tempDir, 'report-auth.xml');
      mockFetch(200, '<xml/>');

      await service.downloadReports({
        ...BASE,
        junitPath: outPath,
        reportType: 'junit',
      });

      expect(captured!.headers['x-app-api-key']).to.equal('test-key');
    });

    it('calls warnLogger on 404 with descriptive message', async () => {
      mockFetch(404, 'Not Found');
      const warnings: string[] = [];

      await service.downloadReports({
        ...BASE,
        reportType: 'junit',
        warnLogger: (msg) => warnings.push(msg),
      });

      const allWarnings = warnings.join(' ');
      expect(allWarnings).to.match(/failed to download junit/i);
      // Gateway converts 404 into "Upload ID '...' not found or no results available..."
      expect(allWarnings).to.match(/not found|no.*available/i);
    });

    it('calls warnLogger on 401 without throwing', async () => {
      mockFetch(401, 'Unauthorized');
      const warnings: string[] = [];

      await service.downloadReports({
        ...BASE,
        reportType: 'allure',
        warnLogger: (msg) => warnings.push(msg),
      });

      expect(warnings.join(' ')).to.match(/failed to download allure/i);
    });
  });

  // -------------------------------------------------------------------------
  // bundle delivery
  // -------------------------------------------------------------------------

  describe('bundle delivery', () => {
    const BASE = {
      auth: TEST_AUTH,
      apiUrl: 'https://api.example.com',
      uploadId: 'run-42',
    };

    let calls: Array<{
      headers: Record<string, string>;
      method: string;
      url: string;
    }>;

    /**
     * Route fetch by URL: a `*-bundle` endpoint returns a signed manifest, and
     * the manifest's `bundleUrl` streams the ZIP. Records every call so the
     * flow (manifest GET, then bundle POST, no inline call) can be asserted.
     */
    function mockBundleFetch(
      opts: {
        manifestBody?: Record<string, unknown>;
        manifestStatus?: number;
        /** Rows for `GET /results/{id}?view=summary`, the --flow lookup. */
        results?: Array<Record<string, unknown>>;
        zipBody?: Buffer | string;
        zipBreaksAfter?: string;
        zipStatus?: number;
      } = {},
    ) {
      const {
        manifestBody = {
          bundleUrl: 'https://cdn.example.com/bundle',
          entryCount: 3,
          filename: 'artifacts-all.zip',
          manifest: '{"version":1}',
          sig: 'SIG',
        },
        manifestStatus = 200,
        results = [],
        zipBody = BUNDLE_ZIP,
        zipBreaksAfter,
        zipStatus = 200,
      } = opts;
      const encoder = new TextEncoder();
      const stream = (s: Buffer | string) =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              typeof s === 'string' ? encoder.encode(s) : new Uint8Array(s),
            );
            controller.close();
          },
        });

      const impl = async (
        input: URL | string,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = input.toString();
        calls.push({
          headers: Object.fromEntries(
            Object.entries((init?.headers as Record<string, string>) ?? {}),
          ),
          method: (init?.method ?? 'GET').toUpperCase(),
          url,
        });

        if (url.includes('?view=summary')) {
          return new Response(
            stream(JSON.stringify({ results, statusCode: 200 })),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          );
        }
        if (url.includes('artifacts-bundle') || url.includes('report-bundle')) {
          return new Response(
            stream(JSON.stringify(manifestBody)),
            {
              headers: { 'content-type': 'application/json' },
              status: manifestStatus,
            },
          );
        }
        if (url === 'https://cdn.example.com/bundle') {
          if (zipBreaksAfter !== undefined) {
            // Sends some bytes, then the connection drops.
            const broken = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(zipBreaksAfter));
              },
              pull(controller) {
                controller.error(
                  Object.assign(new TypeError('terminated'), {
                    cause: { code: 'UND_ERR_SOCKET' },
                  }),
                );
              },
            });
            return new Response(broken, { status: 200 });
          }
          return new Response(stream(zipBody), { status: zipStatus });
        }
        return new Response(stream(INLINE_ZIP), { status: 200 });
      };
      globalThis.fetch = impl as typeof fetch;
    }

    let fallbacks: BundleFallbackTelemetry[];
    const realRecordBundleFallback = telemetry.recordBundleFallback;

    beforeEach(() => {
      calls = [];
      fallbacks = [];
      telemetry.recordBundleFallback = (detail) => {
        fallbacks.push(detail);
      };
    });

    afterEach(() => {
      telemetry.recordBundleFallback = realRecordBundleFallback;
    });

    it('streams from the bundle URL and skips the inline endpoint', async () => {
      mockBundleFetch();
      const outPath = path.join(tempDir, 'bundle.zip');

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(calls[0]).to.include({
        method: 'GET',
        url: 'https://api.example.com/results/run-42/artifacts-bundle?results=ALL',
      });
      expect(calls[1]).to.include({
        method: 'POST',
        url: 'https://cdn.example.com/bundle',
      });
      expect(calls.some((c) => c.url.endsWith('/download'))).to.be.false;
      expect(fs.readFileSync(outPath).equals(BUNDLE_ZIP)).to.be.true;
    });

    it('does not send the auth header to the (pre-signed) bundle URL', async () => {
      mockBundleFetch();

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: path.join(tempDir, 'bundle-noauth.zip'),
        downloadType: 'ALL',
      });

      const bundlePost = calls.find(
        (c) => c.url === 'https://cdn.example.com/bundle',
      );
      expect(bundlePost).to.not.be.undefined;
      expect(bundlePost!.headers['x-app-api-key']).to.be.undefined;
    });

    it('falls back to the inline download when unavailable (501)', async () => {
      mockBundleFetch({ manifestStatus: 501 });
      const outPath = path.join(tempDir, 'bundle-fallback.zip');

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(
        calls.some((c) => c.url.endsWith('/artifacts-bundle?results=ALL')),
      ).to.be.true;
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/download')),
      ).to.be.true;
      expect(fs.readFileSync(outPath).equals(INLINE_ZIP)).to.be.true;
    });

    // dcd#2138: a folder as the artifacts path failed with EISDIR, which the
    // CLI took for a broken stream, so it fell back to the inline download
    // (the API building the whole ZIP) and then failed the same way.
    describe('folder and local file paths', () => {
      it('saves artifacts.zip inside an existing folder', async () => {
        mockBundleFetch();
        const dir = fs.mkdtempSync(path.join(tempDir, 'shard-'));

        const result = await service.downloadArtifacts({
          ...BASE,
          artifactsPath: dir,
          downloadType: 'ALL',
        });

        const file = path.join(dir, 'artifacts.zip');
        expect(result).to.include({ ok: true, path: file });
        expect(fs.readFileSync(file).equals(BUNDLE_ZIP)).to.be.true;
        expect(fallbacks).to.deep.equal([]);
      });

      it('creates a folder given with a trailing separator', async () => {
        mockBundleFetch();
        const dir = path.join(tempDir, 'not-yet', 'here') + path.sep;

        const result = await service.downloadArtifacts({
          ...BASE,
          artifactsPath: dir,
          downloadType: 'ALL',
        });

        const file = path.join(dir, 'artifacts.zip');
        expect(result).to.include({ ok: true, path: file });
        expect(fs.readFileSync(file).equals(BUNDLE_ZIP)).to.be.true;
      });

      it('reports a destination it cannot write, without falling back', async () => {
        mockBundleFetch();
        // A file where a parent folder should be: mkdir fails (ENOTDIR/EEXIST).
        const blocker = path.join(tempDir, 'blocker.txt');
        fs.writeFileSync(blocker, 'x');

        const result = await service.downloadArtifacts({
          ...BASE,
          artifactsPath: path.join(blocker, 'artifacts.zip'),
          downloadType: 'ALL',
        });

        expect(result.ok).to.be.false;
        expect(fallbacks).to.deep.equal([]);
        expect(calls.some((c) => c.url.endsWith('/download'))).to.be.false;
      });
    });

    describe('records why it fell back', () => {
      const download = (name: string) =>
        service.downloadArtifacts({
          ...BASE,
          artifactsPath: path.join(tempDir, name),
          downloadType: 'ALL',
        });

      it('records nothing when the bundle download succeeds', async () => {
        mockBundleFetch();
        await download('ok.zip');
        expect(fallbacks).to.deep.equal([]);
      });

      it('records a 501 as manifest_unavailable, with route and upload id', async () => {
        mockBundleFetch({ manifestStatus: 501 });
        await download('unavailable.zip');

        expect(fallbacks).to.have.length(1);
        expect(fallbacks[0]).to.include({
          reason: 'manifest_unavailable',
          route: 'artifacts-bundle',
          status: 501,
          upload_id: 'run-42',
        });
        expect(fallbacks[0].duration_ms).to.be.a('number');
      });

      it('records a manifest missing its fields as manifest_incomplete', async () => {
        mockBundleFetch({ manifestBody: { bundleUrl: 'https://cdn.example.com/bundle' } });
        await download('incomplete.zip');
        expect(fallbacks[0]).to.include({ reason: 'manifest_incomplete' });
      });

      it('records a non-OK bundle response with its status', async () => {
        mockBundleFetch({ zipStatus: 502 });
        const outPath = path.join(tempDir, 'bundle-502.zip');
        await service.downloadArtifacts({
          ...BASE,
          artifactsPath: outPath,
          downloadType: 'ALL',
        });

        expect(fallbacks[0]).to.include({
          reason: 'bundle_http_error',
          status: 502,
        });
        expect(fs.readFileSync(outPath).equals(INLINE_ZIP)).to.be.true;
      });

      it('records a stream that breaks partway, with the error and bytes received', async () => {
        mockBundleFetch({ zipBreaksAfter: 'partial' });
        const outPath = path.join(tempDir, 'bundle-broken.zip');
        await service.downloadArtifacts({
          ...BASE,
          artifactsPath: outPath,
          downloadType: 'ALL',
        });

        expect(fallbacks[0]).to.include({
          bytes_received: 'partial'.length,
          error_code: 'UND_ERR_SOCKET',
          error_message: 'terminated',
          error_name: 'TypeError',
          reason: 'bundle_stream_failed',
        });
        // The inline download still replaced the partial file.
        expect(fs.readFileSync(outPath).equals(INLINE_ZIP)).to.be.true;
      });

      it('falls back when a bundle ends cleanly but its ZIP is incomplete', async () => {
        // What a bundle that fails after its 200 headers delivers: a clean
        // end of stream, and a ZIP with no central directory.
        const cut = truncated(BUNDLE_ZIP);
        mockBundleFetch({ zipBody: cut });
        const outPath = path.join(tempDir, 'bundle-truncated.zip');

        const result = await service.downloadArtifacts({
          ...BASE,
          artifactsPath: outPath,
          downloadType: 'ALL',
        });

        expect(result.ok).to.equal(true);
        expect(fallbacks).to.have.length(1);
        expect(fallbacks[0]).to.include({
          bytes_received: cut.length,
          error_name: 'IncompleteZipError',
          reason: 'bundle_truncated',
          route: 'artifacts-bundle',
        });
        expect(
          calls.some((c) => c.method === 'POST' && c.url.endsWith('/download')),
        ).to.be.true;
        expect(fs.readFileSync(outPath).equals(INLINE_ZIP)).to.be.true;
      });
    });

    it('uses bundle delivery for the html report', async () => {
      mockBundleFetch();

      await service.downloadReports({
        ...BASE,
        htmlPath: path.join(tempDir, 'report-bundle.zip'),
        reportType: 'html',
      });

      expect(calls[0].url).to.equal(
        'https://api.example.com/results/run-42/report-bundle',
      );
      expect(calls[1]).to.include({
        method: 'POST',
        url: 'https://cdn.example.com/bundle',
      });
    });

    describe('one result (--result-id / --flow)', () => {
      const filteredManifest = {
        bundleUrl: 'https://cdn.example.com/bundle',
        entryCount: 3,
        filename: 'artifacts-result-41-all.zip',
        manifest: '{"version":1}',
        sig: 'SIG',
      };

      it('asks the bundle route for the result, and takes the narrowed bundle', async () => {
        mockBundleFetch({ manifestBody: filteredManifest });
        const outPath = path.join(tempDir, 'one-result.zip');

        const result = await service.downloadArtifacts({
          ...BASE,
          artifactsPath: outPath,
          downloadType: 'ALL',
          resultId: 42,
        });

        expect(result.ok).to.equal(true);
        expect(calls[0].url).to.equal(
          'https://api.example.com/results/run-42/artifacts-bundle?results=ALL&resultId=42',
        );
        expect(fs.readFileSync(outPath).equals(BUNDLE_ZIP)).to.be.true;
      });

      it('sends resultId in the inline body only when set', async () => {
        mockBundleFetch({ manifestBody: filteredManifest, manifestStatus: 501 });
        let inlineBody: string | undefined;
        const routed = globalThis.fetch;
        globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
          if (input.toString().endsWith('/download')) inlineBody = String(init?.body);
          return routed(input, init);
        }) as typeof fetch;

        await service.downloadArtifacts({
          ...BASE,
          artifactsPath: path.join(tempDir, 'one-result-inline.zip'),
          downloadType: 'FAILED',
          resultId: 42,
        });

        expect(JSON.parse(inlineBody!)).to.deep.equal({ results: 'FAILED', resultId: 42 });
      });

      it('refuses a whole-upload bundle from an API that ignored the filter', async () => {
        // An older API: no resultId support, so the usual bundle name.
        mockBundleFetch();
        const outPath = path.join(tempDir, 'old-api.zip');

        const result = await service.downloadArtifacts({
          ...BASE,
          artifactsPath: outPath,
          downloadType: 'ALL',
          resultId: 42,
        });

        expect(result.ok).to.equal(false);
        expect(result.error).to.include('does not support downloading one result');
        // Neither the bundle nor the inline route was downloaded.
        expect(calls.map((c) => c.url)).to.deep.equal([
          'https://api.example.com/results/run-42/artifacts-bundle?results=ALL&resultId=42',
        ]);
        expect(fs.existsSync(outPath)).to.be.false;
      });

      it('resolves --flow to its result id', async () => {
        mockBundleFetch({
          manifestBody: filteredManifest,
          results: [
            { id: 41, retry_of: null, test_file_name: './flows/login.yaml' },
            { id: 43, retry_of: 41, test_file_name: './flows/login.yaml' },
            { id: 44, retry_of: null, test_file_name: './flows/checkout.yaml' },
          ],
        });

        const result = await service.downloadArtifacts({
          ...BASE,
          artifactsPath: path.join(tempDir, 'one-flow.zip'),
          downloadType: 'ALL',
          flow: 'login',
        });

        expect(result.ok).to.equal(true);
        expect(calls[0].url).to.equal(
          'https://api.example.com/results/run-42?view=summary',
        );
        expect(calls[1].url).to.equal(
          'https://api.example.com/results/run-42/artifacts-bundle?results=ALL&resultId=41',
        );
      });

      it('warns, listing the ids, when --flow matches several results', async () => {
        mockBundleFetch({
          results: [
            { config: { deviceName: 'Pixel 8', osVersion: '15' }, id: 41, retry_of: null, test_file_name: 'login.yaml' },
            { config: { deviceName: 'iPhone 16', osVersion: '18' }, id: 42, retry_of: null, test_file_name: 'login.yaml' },
          ],
        });
        const warnings: string[] = [];

        const result = await service.downloadArtifacts({
          ...BASE,
          artifactsPath: path.join(tempDir, 'ambiguous.zip'),
          downloadType: 'ALL',
          flow: 'login',
          warnLogger: (m) => warnings.push(m),
        });

        expect(result.ok).to.equal(false);
        expect(warnings[0]).to.include('matches 2 results');
        expect(warnings[0]).to.include('41 (login.yaml, Pixel 8 15)');
        expect(warnings[0]).to.include('42 (login.yaml, iPhone 16 18)');
        expect(calls.some((c) => c.url.includes('artifacts-bundle'))).to.be.false;
      });
    });
  });
});

describe('matchFlowResult', () => {
  const rows = [
    { id: 1, retry_of: null, test_file_name: './flows/auth/login.yaml' },
    { id: 2, retry_of: 1, test_file_name: './flows/auth/login.yaml' },
    { id: 3, retry_of: null, test_file_name: './flows/checkout.yml' },
  ];

  for (const flow of [
    './flows/auth/login.yaml',
    'flows/auth/login.yaml',
    'login.yaml',
    'login',
  ]) {
    it(`matches '${flow}' to the first attempt`, () => {
      expect(matchFlowResult(rows, flow)).to.equal(1);
    });
  }

  it('matches a .yml flow by its name', () => {
    expect(matchFlowResult(rows, 'checkout')).to.equal(3);
  });

  it('fails when nothing matches', () => {
    expect(() => matchFlowResult(rows, 'signup')).to.throw(
      "No flow matching 'signup' in this upload",
    );
  });

  it('never matches a part of a name', () => {
    expect(() => matchFlowResult(rows, 'log')).to.throw(/No flow matching/);
  });
});

// The HTML report (html and html-detailed alike) is a ZIP of report.html and
// its assets, so saving it as ./report.html by default produced a file no
// browser could open.
describe('ReportDownloadService default report paths', () => {
  const realDownload = ApiGateway.downloadReportGeneric;
  let saved: Array<{ filePath?: string; type: string }>;

  beforeEach(() => {
    saved = [];
    ApiGateway.downloadReportGeneric = (async (
      _baseUrl: string,
      _auth: AuthContext,
      _uploadId: string,
      type: 'allure' | 'html' | 'junit',
      filePath?: string,
    ) => {
      saved.push({ filePath, type });
    }) as typeof ApiGateway.downloadReportGeneric;
  });

  afterEach(() => {
    ApiGateway.downloadReportGeneric = realDownload;
  });

  const download = (
    reportType: 'allure' | 'html' | 'html-detailed' | 'junit',
    paths: { allurePath?: string; htmlPath?: string; junitPath?: string } = {},
  ) =>
    new ReportDownloadService().downloadReports({
      apiUrl: 'https://api.example.com',
      auth: TEST_AUTH,
      reportType,
      uploadId: 'u1',
      ...paths,
    });

  it('saves html and html-detailed reports to ./report.zip', async () => {
    await download('html');
    await download('html-detailed');

    const zip = path.resolve(process.cwd(), 'report.zip');
    expect(saved).to.deep.equal([
      { filePath: zip, type: 'html' },
      { filePath: zip, type: 'html' },
    ]);
  });

  it('keeps an explicit --html-path exactly as given', async () => {
    await download('html', { htmlPath: 'out/report.html' });
    expect(saved[0].filePath).to.equal(path.resolve(process.cwd(), 'out/report.html'));
  });

  it('leaves the junit and allure defaults alone', async () => {
    await download('junit');
    await download('allure');

    expect(saved.map((s) => s.filePath)).to.deep.equal([
      path.resolve(process.cwd(), 'report.xml'),
      path.resolve(process.cwd(), 'report.html'),
    ]);
  });
});

// allure and html-detailed go on 7 December 2026. The values stay
// valid (a run that asks for one must not fail), so the only signal is this.
describe('reportFormatDeprecation', () => {
  it('names the date and the replacement for allure', () => {
    const message = reportFormatDeprecation('allure');
    expect(message).to.include('7 December 2026');
    expect(message).to.include('--report html or --report junit');
  });

  it('names the date and the replacement for html-detailed', () => {
    const message = reportFormatDeprecation('html-detailed');
    expect(message).to.include('7 December 2026');
    expect(message).to.include('--report html instead');
  });

  it('says nothing for the formats that stay, or for no format', () => {
    for (const report of ['junit', 'html', undefined]) {
      expect(reportFormatDeprecation(report)).to.equal(undefined);
    }
  });
});

describe('downloadsSucceeded', () => {
  const ok = { ok: true, path: 'a.zip', type: 'artifacts' } as const;
  const failed = { error: 'boom', ok: false, path: 'a.zip', type: 'artifacts' } as const;

  it('is true only when every download succeeded', () => {
    expect(downloadsSucceeded([ok])).to.equal(true);
    expect(downloadsSucceeded([failed])).to.equal(false);
    expect(downloadsSucceeded([ok, failed])).to.equal(false);
  });

  it('is false when nothing was downloaded', () => {
    expect(downloadsSucceeded([])).to.equal(false);
  });
});
