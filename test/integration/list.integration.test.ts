import { expect } from 'chai';

import {
  CLI,
  DEAD_API_URL,
  MOCK_API_KEY,
  MOCK_API_URL,
  exec,
  runExpectingFailure,
} from './helpers';

describe('List Command Integration Tests', () => {
  const mockApiUrl = MOCK_API_URL;
  const mockApiKey = MOCK_API_KEY;

  // The mock API returns Prism's example list response: one upload with
  // total 1, limit 20, offset 0.
  const expectListJson = (stdout: string) => {
    const result = JSON.parse(stdout);
    expect(result).to.have.property('uploads');
    expect(result.uploads).to.be.an('array').that.is.not.empty;
    expect(result).to.have.property('total');
    expect(result).to.have.property('limit');
    expect(result).to.have.property('offset');
    return result;
  };

  describe('basic list functionality', () => {
    it('should require API key', async () => {
      const command = `${CLI} list --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('API key');
    });

    it('should accept API key from environment variable', async () => {
      const command = `${CLI} list --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, {
        env: { ...process.env, DEVICE_CLOUD_API_KEY: mockApiKey },
        timeout: 15_000,
      });
      expectListJson(stdout);
    });

    it('should accept API key from flag', async () => {
      const command = `${CLI} list --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectListJson(stdout);
    });
  });

  describe('filtering options', () => {
    it('should accept name filter with wildcard', async () => {
      const command = `${CLI} list --name "nightly-*" --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectListJson(stdout);
    });

    it('should accept from date filter', async () => {
      const command = `${CLI} list --from 2024-01-01 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectListJson(stdout);
    });

    it('should accept to date filter', async () => {
      const command = `${CLI} list --to 2024-12-31 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectListJson(stdout);
    });

    it('should accept date range filters', async () => {
      const command = `${CLI} list --from 2024-01-01 --to 2024-12-31 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectListJson(stdout);
    });

    it('should reject invalid from date format', async () => {
      const command = `${CLI} list --from "not-a-date" --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('Invalid --from date');
      expect(output).to.include('ISO 8601');
    });

    it('should reject invalid to date format', async () => {
      const command = `${CLI} list --to "invalid" --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('Invalid --to date');
      expect(output).to.include('ISO 8601');
    });
  });

  describe('pagination options', () => {
    it('should accept limit parameter', async () => {
      const command = `${CLI} list --limit 10 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectListJson(stdout);
    });

    it('should accept offset parameter', async () => {
      const command = `${CLI} list --offset 20 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectListJson(stdout);
    });

    it('should reject a non-numeric limit', async () => {
      const command = `${CLI} list --limit ten --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.match(/invalid integer value for --limit/i);
    });

    it('should use default limit of 20', async () => {
      const command = `${CLI} list --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      const result = expectListJson(stdout);
      expect(result.limit).to.equal(20);
    });
  });

  describe('output formats', () => {
    it('should support JSON output format', async () => {
      const command = `${CLI} list --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectListJson(stdout);
    });

    it('should support table output format by default', async () => {
      const command = `${CLI} list --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Recent Uploads');
      expect(stdout).to.match(/Showing \d+ of \d+ uploads/);
    });
  });

  describe('error handling', () => {
    it('should handle network failures gracefully', async () => {
      const command = `${CLI} list --api-key ${mockApiKey} --api-url ${DEAD_API_URL}`;

      const { code, output } = await runExpectingFailure(command, {
        timeout: 30_000,
      });
      expect(code).to.equal(1);
      expect(output).to.include('Network request failed');
    });

    it('should handle invalid API key', async () => {
      const command = `${CLI} list --api-key invalid-key --api-url ${mockApiUrl} --json`;

      const { code, stdout } = await runExpectingFailure(command);
      expect(code).to.equal(1);
      // --json failures are emitted as JSON on stdout.
      const result = JSON.parse(stdout);
      expect(result).to.have.property('error');
      expect(result.error).to.include('Failed to list uploads');
      expect(result.error).to.include('Authentication failed');
    });
  });

  describe('help and validation', () => {
    it('should show help information', async () => {
      const command = `${CLI} list --help`;

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
      const command = `${CLI} list --help`;

      const { stdout } = await exec(command, { timeout: 10_000 });
      expect(stdout).to.match(/USAGE/i);
    });
  });

  describe('combined filters', () => {
    it('should accept multiple filters together', async () => {
      const command = `${CLI} list --name "test-*" --from 2024-01-01 --to 2024-12-31 --limit 10 --offset 0 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectListJson(stdout);
    });
  });
});
