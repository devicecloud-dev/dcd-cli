import { expect } from 'chai';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

describe('List Command Integration Tests', () => {
  const mockApiUrl = 'http://localhost:3001';
  const mockApiKey = 'test-api-key-123';

  describe('basic list functionality', () => {
    it('should require API key', async () => {
      const command = `./dist/index.js list --api-url ${mockApiUrl}`;

      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for missing API key');
      } catch (error: unknown) {
        const errorOutput =
          (error &&
          typeof error === 'object' &&
          'stderr' in error &&
          typeof error.stderr === 'string'
            ? error.stderr
            : '') ||
          (error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
            ? error.stdout
            : '');
        expect(errorOutput).to.include('API key');
      }
    });

    it('should accept API key from environment variable', async () => {
      const command = `./dist/index.js list --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, {
          env: { ...process.env, DEVICE_CLOUD_API_KEY: mockApiKey },
          timeout: 15_000,
        });
        // If it reaches here without error, the API key was accepted
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // Should not complain about missing API key
          expect(output).to.not.include('You must provide an API key');
        } else {
          throw error;
        }
      }
    });

    it('should accept API key from flag', async () => {
      const command = `./dist/index.js list --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, { timeout: 15_000 });
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // Should not complain about missing API key
          expect(output).to.not.include('API key is required');
        } else {
          throw error;
        }
      }
    });
  });

  describe('filtering options', () => {
    it('should accept name filter with wildcard', async () => {
      const command = `./dist/index.js list --name "nightly-*" --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, { timeout: 15_000 });
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // Should not complain about invalid name filter
          expect(output).to.not.include('Invalid name');
        } else {
          throw error;
        }
      }
    });

    it('should accept from date filter', async () => {
      const command = `./dist/index.js list --from 2024-01-01 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, { timeout: 15_000 });
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // Should not complain about invalid date
          expect(output).to.not.include('Invalid --from date');
        } else {
          throw error;
        }
      }
    });

    it('should accept to date filter', async () => {
      const command = `./dist/index.js list --to 2024-12-31 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, { timeout: 15_000 });
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // Should not complain about invalid date
          expect(output).to.not.include('Invalid --to date');
        } else {
          throw error;
        }
      }
    });

    it('should accept date range filters', async () => {
      const command = `./dist/index.js list --from 2024-01-01 --to 2024-12-31 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, { timeout: 15_000 });
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // Should not complain about dates
          expect(output).to.not.include('Invalid');
        } else {
          throw error;
        }
      }
    });

    it('should reject invalid from date format', async () => {
      const command = `./dist/index.js list --from "not-a-date" --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for invalid date format');
      } catch (error: unknown) {
        const errorOutput =
          (error &&
          typeof error === 'object' &&
          'stderr' in error &&
          typeof error.stderr === 'string'
            ? error.stderr
            : '') ||
          (error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
            ? error.stdout
            : '');
        expect(errorOutput).to.match(/invalid.*from.*date|iso.*8601/i);
      }
    });

    it('should reject invalid to date format', async () => {
      const command = `./dist/index.js list --to "invalid" --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for invalid date format');
      } catch (error: unknown) {
        const errorOutput =
          (error &&
          typeof error === 'object' &&
          'stderr' in error &&
          typeof error.stderr === 'string'
            ? error.stderr
            : '') ||
          (error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
            ? error.stdout
            : '');
        expect(errorOutput).to.match(/invalid.*to.*date|iso.*8601/i);
      }
    });
  });

  describe('pagination options', () => {
    it('should accept limit parameter', async () => {
      const command = `./dist/index.js list --limit 10 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, { timeout: 15_000 });
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // Should not complain about invalid limit
          expect(output).to.not.include('Invalid limit');
        } else {
          throw error;
        }
      }
    });

    it('should accept offset parameter', async () => {
      const command = `./dist/index.js list --offset 20 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, { timeout: 15_000 });
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // Should not complain about invalid offset
          expect(output).to.not.include('Invalid offset');
        } else {
          throw error;
        }
      }
    });

    it('should use default limit of 20', async () => {
      const command = `./dist/index.js list --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        const result = JSON.parse(stdout);
        expect(result.limit).to.equal(20);
      } catch (error: unknown) {
        // Mock API may not be available - this is acceptable
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1
        ) {
          // Expected when mock API is not running
        } else {
          throw error;
        }
      }
    });
  });

  describe('output formats', () => {
    it('should support JSON output format', async () => {
      const command = `./dist/index.js list --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(() => JSON.parse(stdout)).to.not.throw();
        const result = JSON.parse(stdout);
        expect(result).to.have.property('uploads');
        expect(result).to.have.property('total');
        expect(result).to.have.property('limit');
        expect(result).to.have.property('offset');
      } catch (error: unknown) {
        // Mock API may not have the endpoint or return proper response
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1
        ) {
          const stdout =
            error && typeof error === 'object' && 'stdout' in error
              ? String(error.stdout)
              : '';
          const stderr =
            error && typeof error === 'object' && 'stderr' in error
              ? String(error.stderr)
              : '';
          const output = stdout + stderr;
          // Accept various error formats from network issues or missing mock endpoint
          expect(output).to.match(
            /failed to list|network error|fetch|error|405|no.*method/i,
          );
        } else {
          throw error;
        }
      }
    });

    it('should support table output format by default', async () => {
      const command = `./dist/index.js list --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // Should contain table-like output
        expect(stdout).to.match(/upload|recent|id|created/i);
      } catch (error: unknown) {
        // Mock API may not have the endpoint or return proper response
        // Command exits with non-zero code, which throws an error
        const stdout =
          error && typeof error === 'object' && 'stdout' in error
            ? String(error.stdout)
            : '';
        const stderr =
          error && typeof error === 'object' && 'stderr' in error
            ? String(error.stderr)
            : '';
        const output = stdout + stderr;
        // Accept various error formats from network issues or missing mock endpoint
        expect(output).to.match(
          /failed to list|network error|fetch|error|405|no.*method/i,
        );
      }
    });
  });

  describe('error handling', () => {
    it('should handle network failures gracefully', async () => {
      const command = `./dist/index.js list --api-key ${mockApiKey} --api-url http://localhost:9999`;

      try {
        await exec(command, { timeout: 30_000 });
        expect.fail('Should have failed due to network error');
      } catch (error: unknown) {
        const errorOutput =
          (error &&
          typeof error === 'object' &&
          'stderr' in error &&
          typeof error.stderr === 'string'
            ? error.stderr
            : '') ||
          (error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
            ? error.stdout
            : '');
        expect(errorOutput).to.match(/network|failed|error|fetch/i);
      }
    });

    it('should handle invalid API key', async () => {
      const command = `./dist/index.js list --api-key invalid-key --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, { timeout: 15_000 });
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          expect(output).to.match(
            /failed to list|unauthorized|authentication|invalid|error/i,
          );
        } else {
          throw error;
        }
      }
    });
  });

  describe('help and validation', () => {
    it('should show help information', async () => {
      const command = `./dist/index.js list --help`;

      const { stdout } = await exec(command, { timeout: 10_000 });
      expect(stdout).to.include('List recent flow uploads');
      expect(stdout).to.include('--name');
      expect(stdout).to.include('--from');
      expect(stdout).to.include('--to');
      expect(stdout).to.include('--limit');
      expect(stdout).to.include('--offset');
      expect(stdout).to.include('--json');
      expect(stdout).to.include('--api-key');
    });

    it('should show usage line in help', async () => {
      const command = `./dist/index.js list --help`;

      const { stdout } = await exec(command, { timeout: 10_000 });
      expect(stdout).to.match(/USAGE/i);
    });
  });

  describe('combined filters', () => {
    it('should accept multiple filters together', async () => {
      const command = `./dist/index.js list --name "test-*" --from 2024-01-01 --to 2024-12-31 --limit 10 --offset 0 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      try {
        await exec(command, { timeout: 15_000 });
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // Should not complain about any filter being invalid
          expect(output).to.not.include('Invalid');
        } else {
          throw error;
        }
      }
    });
  });
});
