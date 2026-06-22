import { expect } from 'chai';

import {
  CLI,
  DEAD_API_URL,
  MOCK_API_KEY,
  MOCK_API_URL,
  exec,
  runExpectingFailure,
} from './helpers.js';

describe('Status Command Integration Tests', () => {
  const mockApiUrl = MOCK_API_URL;
  const mockApiKey = MOCK_API_KEY;

  // The mock API returns Prism's example status response.
  const expectStatusJson = (stdout: string) => {
    const result = JSON.parse(stdout);
    expect(result).to.have.property('uploadId');
    expect(result.uploadId).to.be.a('string');
    expect(result).to.have.property('status');
    expect(result).to.have.property('tests');
    expect(result.tests).to.be.an('array');
    return result;
  };

  describe('basic status functionality', () => {
    it('should require API key', async () => {
      const command = `${CLI} status --upload-id test-123 --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('API key');
    });

    it('should accept API key from environment variable', async () => {
      const command = `${CLI} status --upload-id test-123 --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, {
        env: { ...process.env, DEVICE_CLOUD_API_KEY: mockApiKey },
        timeout: 15_000,
      });
      expectStatusJson(stdout);
    });

    it('should require either upload-id or name parameter', async () => {
      const command = `${CLI} status --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('Either --name or --upload-id must be provided');
    });

    it('should handle status check by upload ID', async () => {
      const command = `${CLI} status --upload-id test-upload-123 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectStatusJson(stdout);
    });

    it('should handle status check by name', async () => {
      const command = `${CLI} status --name test-run-name --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectStatusJson(stdout);
    });

    it('should reject both upload-id and name parameters', async () => {
      const command = `${CLI} status --upload-id test-123 --name test-name --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('Cannot provide both --name and --upload-id');
      expect(output).to.include('mutually exclusive');
    });
  });

  describe('output formats', () => {
    it('should support JSON output format', async () => {
      const command = `${CLI} status --upload-id test-123 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectStatusJson(stdout);
    });

    it('should support table output format by default', async () => {
      const command = `${CLI} status --upload-id test-123 --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Upload Status');
      expect(stdout).to.include('Test Results');
      // Should not be JSON format
      expect(() => JSON.parse(stdout)).to.throw();
    });
  });

  describe('error handling and retries', () => {
    it('should handle network failures with retries', async () => {
      const command = `${CLI} status --upload-id test-123 --api-key ${mockApiKey} --api-url ${DEAD_API_URL}`;

      // Retries with backoff take ~10s before giving up.
      const { code, output } = await runExpectingFailure(command, {
        timeout: 30_000,
      });
      expect(code).to.equal(1);
      expect(output).to.include('Network request failed');
    });

    it('should report invalid API key errors in the JSON output', async () => {
      const command = `${CLI} status --upload-id test-123 --api-key invalid-key --api-url ${mockApiUrl} --json`;

      // status --json reports errors in-band (JSON on stdout, exit 0) and
      // does not retry client errors — `attempts` stays at 1.
      const { stdout } = await exec(command, { timeout: 15_000 });
      const result = JSON.parse(stdout);
      expect(result).to.have.property('status', 'FAILED');
      expect(result.error).to.include('Authentication failed');
      expect(result).to.have.property('attempts', 1);
    });
  });

  describe('help and validation', () => {
    it('should show help information', async () => {
      const command = `${CLI} status --help`;

      const { stdout } = await exec(command, { timeout: 10_000 });
      expect(stdout).to.include('Get the status of an upload');
      expect(stdout).to.include('--upload-id');
      expect(stdout).to.include('--name');
      expect(stdout).to.include('--api-key');
    });

    it('should reject an empty upload-id', async () => {
      const command = `${CLI} status --upload-id "" --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('Either --name or --upload-id must be provided');
    });
  });
});
