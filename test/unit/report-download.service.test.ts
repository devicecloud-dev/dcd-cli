import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ReportDownloadService } from '../../src/services/report-download.service.js';
import type { AuthContext } from '../../src/types/domain/auth.types.js';

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalFetch = (global as any).fetch;

/**
 * Replace global.fetch with a mock that records what it was called with and
 * returns the given status + body content. The body is served as a
 * ReadableStream so that Readable.fromWeb() in the gateway can consume it.
 * @param status HTTP status code to return
 * @param responseBody Response body string
 * @returns void
 */
function mockFetch(status: number, responseBody = 'fake-zip-content') {
  const encoder = new TextEncoder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        controller.enqueue(encoder.encode(responseBody));
        controller.close();
      },
    });

    return new Response(stream, { status });
  };
}

function restoreFetch() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = originalFetch;
  captured = null;
}

/**
 * Replace global.fetch with a mock that serves the given responses in call
 * order (the last one repeats) and records every request. Used for the
 * signed-URL delivery flows, which make more than one request.
 * @param responses Status/body/content-type per sequential call
 * @returns The list of captured requests, appended to live
 */
function mockFetchSequence(
  responses: Array<{ body: string; contentType?: string; status: number }>,
): CapturedRequest[] {
  const encoder = new TextEncoder();
  const calls: CapturedRequest[] = [];
  (global as any).fetch = async (
    input: URL | string,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      body: init?.body ? String(init.body) : null,
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      ),
      method: (init?.method ?? 'GET').toUpperCase(),
      url: input.toString(),
    });

    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(next.body));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: next.contentType ? { 'content-type': next.contentType } : {},
      status: next.status,
    });
  };

  return calls;
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
      expect(JSON.parse(captured!.body!)).to.deep.equal({ delivery: 'url', results: 'FAILED' });
    });

    it('calls POST /results/{uploadId}/download with body results: ALL', async () => {
      const outPath = path.join(tempDir, 'artifacts-all.zip');
      mockFetch(200);

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(JSON.parse(captured!.body!)).to.deep.equal({ delivery: 'url', results: 'ALL' });
    });

    it('writes the response body to the specified file path', async () => {
      const outPath = path.join(tempDir, 'written.zip');
      mockFetch(200, 'zip-file-contents');

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(fs.existsSync(outPath)).to.be.true;
      expect(fs.readFileSync(outPath, 'utf8')).to.equal('zip-file-contents');
    });

    it('creates intermediate directories if they do not exist', async () => {
      const outPath = path.join(tempDir, 'nested', 'dir', 'artifacts.zip');
      mockFetch(200, 'content');

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
      mockFetch(200, 'data');

      const logs: string[] = [];

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
        logger: (msg) => logs.push(msg),
      });

      expect(logs.join(' ')).to.include(outPath);
    });

    it('follows signed-URL delivery when the API responds with JSON', async () => {
      const outPath = path.join(tempDir, 'signed-url.zip');
      const calls = mockFetchSequence([
        {
          body: JSON.stringify({ url: 'https://storage.example.com/bundle.zip?sig=abc' }),
          contentType: 'application/json',
          status: 200,
        },
        { body: 'zip-from-storage', status: 200 },
      ]);

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'ALL',
      });

      expect(calls).to.have.length(2);
      expect(calls[1].url).to.equal('https://storage.example.com/bundle.zip?sig=abc');
      // The URL is pre-signed — auth headers must not leak to storage.
      expect(calls[1].headers).to.not.have.property('x-app-api-key');
      expect(fs.readFileSync(outPath, 'utf8')).to.equal('zip-from-storage');
    });

    it('falls back to inline delivery when the API returns 501', async () => {
      const outPath = path.join(tempDir, 'fallback.zip');
      const calls = mockFetchSequence([
        { body: JSON.stringify({ message: 'unavailable' }), contentType: 'application/json', status: 501 },
        { body: 'inline-zip', status: 200 },
      ]);

      await service.downloadArtifacts({
        ...BASE,
        artifactsPath: outPath,
        downloadType: 'FAILED',
      });

      expect(calls).to.have.length(2);
      expect(JSON.parse(calls[1].body!)).to.deep.equal({ results: 'FAILED' });
      expect(fs.readFileSync(outPath, 'utf8')).to.equal('inline-zip');
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
      mockFetch(200, '<html2/>');

      await service.downloadReports({
        ...BASE,
        htmlPath: outPath,
        reportType: 'html',
      });

      expect(captured!.url).to.equal(
        'https://api.example.com/results/upload-xyz-456/html-report?delivery=url',
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
});
