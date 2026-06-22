import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CLI,
  DEAD_API_URL,
  MOCK_API_KEY,
  MOCK_API_URL,
  exec,
  runExpectingFailure,
} from './helpers.js';

describe('Artifacts Command Integration Tests', () => {
  const mockApiUrl = MOCK_API_URL;
  const mockApiKey = MOCK_API_KEY;
  const mockUploadId = '123e4567-e89b-12d3-a456-426614174000';
  // Downloads write into cwd, so keep them out of the repo tree.
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-artifacts-test-'));
  });

  after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  const run = (args: string, env?: Record<string, string>) =>
    exec(`${CLI} artifacts ${args}`, {
      cwd: tempDir,
      env: { ...process.env, ...env },
      timeout: 15_000,
    });

  const runFailing = (args: string, env?: Record<string, string>) =>
    runExpectingFailure(`${CLI} artifacts ${args}`, {
      cwd: tempDir,
      env: { ...process.env, ...env },
    });

  describe('flag validation', () => {
    it('should require --upload-id', async () => {
      const { output } = await runFailing(
        `--download-artifacts FAILED --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
      );
      expect(output).to.match(/upload-id/i);
    });

    it('should require either --download-artifacts or --report', async () => {
      const { output } = await runFailing(
        `--upload-id ${mockUploadId} --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
      );
      expect(output).to.match(/download-artifacts|report/i);
    });

    it('should reject --download-artifacts and --report together', async () => {
      const { output } = await runFailing(
        `--upload-id ${mockUploadId} --download-artifacts FAILED --report junit --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
      );
      expect(output).to.match(/cannot also be provided/i);
    });

    it('should reject --artifacts-path without --download-artifacts', async () => {
      const { output } = await runFailing(
        `--upload-id ${mockUploadId} --artifacts-path ./out.zip --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
      );
      expect(output).to.match(/artifacts-path|download-artifacts/i);
    });

    it('should reject --junit-path without --report', async () => {
      const { output } = await runFailing(
        `--upload-id ${mockUploadId} --junit-path ./report.xml --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
      );
      expect(output).to.match(/junit-path|report/i);
    });

    it('should only accept ALL or FAILED for --download-artifacts', async () => {
      const { output } = await runFailing(
        `--upload-id ${mockUploadId} --download-artifacts SOME --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
      );
      expect(output).to.match(/all|failed|expected.*to be one of/i);
    });
  });

  describe('authentication', () => {
    it('should require an API key', async () => {
      const { output } = await runFailing(
        `--upload-id ${mockUploadId} --download-artifacts FAILED --api-url ${mockApiUrl}`,
        { DEVICE_CLOUD_API_KEY: '' },
      );
      expect(output).to.match(/api key/i);
    });

    it('should accept API key from environment variable', async () => {
      // Download failures against the mock are warnings, not errors — the
      // command exits 0 once the key is accepted (see download behaviour below).
      const { stderr } = await run(
        `--upload-id ${mockUploadId} --download-artifacts FAILED --api-url ${mockApiUrl}`,
        { DEVICE_CLOUD_API_KEY: mockApiKey },
      );
      expect(stderr).to.not.match(/api key is required/i);
    });
  });

  describe('download behaviour against the mock API', () => {
    // Prism can't serve the binary download endpoints, so the deterministic
    // outcome is a warning and exit 0 — download failures must not fail the
    // command or crash.
    it('should warn and exit 0 when artifacts download fails', async () => {
      const { stderr } = await run(
        `--upload-id ${mockUploadId} --download-artifacts FAILED --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
      );
      expect(stderr).to.include('Failed to download artifacts');
    });

    it('should download the junit report', async () => {
      // Unlike the artifacts zip, Prism can serve the junit report endpoint.
      const { stdout } = await run(
        `--upload-id ${mockUploadId} --report junit --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
      );
      expect(stdout).to.include('JUNIT test report has been downloaded');
      expect(fs.existsSync(path.join(tempDir, 'report.xml'))).to.be.true;
    });
  });

  describe('network error handling', () => {
    it('should handle unreachable API gracefully for --download-artifacts', async () => {
      // Should warn, not crash with an uncaught exception
      const { stderr, stdout } = await run(
        `--upload-id ${mockUploadId} --download-artifacts FAILED --api-key ${mockApiKey} --api-url ${DEAD_API_URL}`,
      );
      expect(stderr + stdout).to.not.match(/typeerror|unhandledpromiserejection/i);
      expect(stderr).to.include('Failed to download artifacts');
    });

    it('should handle unreachable API gracefully for --report', async () => {
      const { stderr, stdout } = await run(
        `--upload-id ${mockUploadId} --report junit --api-key ${mockApiKey} --api-url ${DEAD_API_URL}`,
      );
      expect(stderr + stdout).to.not.match(/typeerror|unhandledpromiserejection/i);
      expect(stderr).to.match(/failed to download/i);
    });
  });

  describe('help', () => {
    it('should display help with all expected flags', async () => {
      const { stdout } = await exec(`${CLI} artifacts --help`, {
        timeout: 10_000,
      });
      expect(stdout).to.include('--upload-id');
      expect(stdout).to.include('--download-artifacts');
      expect(stdout).to.include('--artifacts-path');
      expect(stdout).to.include('--report');
      expect(stdout).to.include('--junit-path');
      expect(stdout).to.include('--allure-path');
      expect(stdout).to.include('--html-path');
    });
  });
});
