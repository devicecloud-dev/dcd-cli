import { expect } from 'chai';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

const run = (args: string, env?: Record<string, string>) =>
  exec(`./dist/index.js artifacts ${args}`, {
    env: { ...process.env, ...env },
    timeout: 15_000,
  });

const errorOutput = (error: unknown): string => {
  if (error && typeof error === 'object') {
    if ('stderr' in error && typeof error.stderr === 'string' && error.stderr) return error.stderr;
    if ('stdout' in error && typeof error.stdout === 'string' && error.stdout) return error.stdout;
  }

  return '';
};

describe('Artifacts Command Integration Tests', () => {
  const mockApiUrl = 'http://localhost:3001';
  const mockApiKey = 'test-api-key-123';
  const mockUploadId = '123e4567-e89b-12d3-a456-426614174000';

  describe('flag validation', () => {
    it('should require --upload-id', async () => {
      try {
        await run(`--download-artifacts FAILED --api-key ${mockApiKey} --api-url ${mockApiUrl}`);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(errorOutput(error)).to.match(/upload-id/i);
      }
    });

    it('should require either --download-artifacts or --report', async () => {
      try {
        await run(`--upload-id ${mockUploadId} --api-key ${mockApiKey} --api-url ${mockApiUrl}`);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(errorOutput(error)).to.match(/download-artifacts|report/i);
      }
    });

    it('should reject --download-artifacts and --report together', async () => {
      try {
        await run(
          `--upload-id ${mockUploadId} --download-artifacts FAILED --report junit --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
        );
        expect.fail('Should have thrown');
      } catch (error) {
        expect(errorOutput(error)).to.match(/cannot also be provided/i);
      }
    });

    it('should reject --artifacts-path without --download-artifacts', async () => {
      try {
        await run(
          `--upload-id ${mockUploadId} --artifacts-path ./out.zip --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
        );
        expect.fail('Should have thrown');
      } catch (error) {
        expect(errorOutput(error)).to.match(/artifacts-path|download-artifacts/i);
      }
    });

    it('should reject --junit-path without --report', async () => {
      try {
        await run(
          `--upload-id ${mockUploadId} --junit-path ./report.xml --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
        );
        expect.fail('Should have thrown');
      } catch (error) {
        expect(errorOutput(error)).to.match(/junit-path|report/i);
      }
    });

    it('should only accept ALL or FAILED for --download-artifacts', async () => {
      try {
        await run(
          `--upload-id ${mockUploadId} --download-artifacts SOME --api-key ${mockApiKey} --api-url ${mockApiUrl}`,
        );
        expect.fail('Should have thrown');
      } catch (error) {
        expect(errorOutput(error)).to.match(/all|failed|expected.*to be one of/i);
      }
    });
  });

  describe('authentication', () => {
    it('should require an API key', async () => {
      try {
        await run(
          `--upload-id ${mockUploadId} --download-artifacts FAILED --api-url ${mockApiUrl}`,
          { DEVICE_CLOUD_API_KEY: '' },
        );
        expect.fail('Should have thrown');
      } catch (error) {
        expect(errorOutput(error)).to.match(/api key/i);
      }
    });

    it('should accept API key from environment variable', async () => {
      try {
        await run(
          `--upload-id ${mockUploadId} --download-artifacts FAILED --api-url ${mockApiUrl}`,
          { DEVICE_CLOUD_API_KEY: mockApiKey },
        );
      } catch (error) {
        // API unreachable is fine — the key was accepted if we don't see the key error
        expect(errorOutput(error)).to.not.match(/api key is required/i);
      }
    });
  });

  describe('network error handling', () => {
    it('should handle unreachable API gracefully for --download-artifacts', async () => {
      try {
        await run(
          `--upload-id ${mockUploadId} --download-artifacts FAILED --api-key ${mockApiKey} --api-url http://localhost:9999`,
        );
      } catch (error) {
        // Should warn, not crash with an uncaught exception
        const out = errorOutput(error);
        expect(out).to.not.match(/typeerror|unhandledpromiserejection/i);
      }
    });

    it('should handle unreachable API gracefully for --report', async () => {
      try {
        await run(
          `--upload-id ${mockUploadId} --report junit --api-key ${mockApiKey} --api-url http://localhost:9999`,
        );
      } catch (error) {
        const out = errorOutput(error);
        expect(out).to.not.match(/typeerror|unhandledpromiserejection/i);
      }
    });
  });

  describe('help', () => {
    it('should display help with all expected flags', async () => {
      const { stdout } = await exec('./dist/index.js artifacts --help', { timeout: 10_000 });
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
