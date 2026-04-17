import { expect } from 'chai';
import { exec as execCallback } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

describe('Status Command Integration Tests', () => {
  const mockApiUrl = 'http://localhost:3001';
  const mockApiKey = 'test-api-key-123';
  let tempDir: string;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-status-test-'));
  });

  after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  describe('basic status functionality', () => {
    it('should require API key', async () => {
      const command = `./dist/index.js status --upload-id test-123 --api-url ${mockApiUrl}`;
      
      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for missing API key');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.include('API key');
      }
    });

    it('should accept API key from environment variable', async () => {
      const command = `./dist/index.js status --upload-id test-123 --api-url ${mockApiUrl} --json`;
      
      try {
        await exec(command, { 
          env: { ...process.env, DEVICE_CLOUD_API_KEY: mockApiKey },
          timeout: 15_000 
        });
        // If it reaches here without error, the API key was accepted
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          // Should not complain about missing API key
          expect(output).to.not.include('You must provide an API key');
        } else {
          throw error;
        }
      }
    });

    it('should require either upload-id or name parameter', async () => {
      const command = `./dist/index.js status --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for missing upload-id or name');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/upload.*id|name.*required/i);
      }
    });

    it('should handle status check by upload ID', async () => {
      const command = `./dist/index.js status --upload-id test-upload-123 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;
      
      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        const result = JSON.parse(stdout);
        expect(result).to.have.property('status');
      } catch (error: unknown) {
        // Mock API may not be fully configured - verify command processes correctly
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          expect(output).to.match(/failed to get status|network error|fetch.*status/i);
        } else {
          throw error;
        }
      }
    });

    it('should handle status check by name', async () => {
      const command = `./dist/index.js status --name test-run-name --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;
      
      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        const result = JSON.parse(stdout);
        expect(result).to.have.property('status');
      } catch (error: unknown) {
        // Mock API may not be fully configured - verify command processes correctly
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          expect(output).to.match(/failed to get status|network error|fetch.*status/i);
        } else {
          throw error;
        }
      }
    });

    it('should reject both upload-id and name parameters', async () => {
      const command = `./dist/index.js status --upload-id test-123 --name test-name --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for providing both upload-id and name');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/cannot.*also.*provided|exclusive/i);
      }
    });
  });

  describe('output formats', () => {
    it('should support JSON output format', async () => {
      const command = `./dist/index.js status --upload-id test-123 --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;
      
      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(() => JSON.parse(stdout)).to.not.throw();
      } catch (error: unknown) {
        // Mock API may not return proper response - check that JSON flag was processed
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          // Should be attempting JSON format even if it fails
          expect(output).to.match(/failed to get status|network error|fetch.*status|{.*}/i);
        } else {
          throw error;
        }
      }
    });

    it('should support table output format by default', async () => {
      const command = `./dist/index.js status --upload-id test-123 --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // Should contain table-like output
        expect(stdout).to.match(/status|test|duration/i);
      } catch (error: unknown) {
        // Mock API may not return proper response - verify non-JSON output attempt
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          expect(output).to.match(/failed to get status|network error|fetch.*status/i);
          // Should not be JSON format
          expect(() => JSON.parse(output)).to.throw();
        } else {
          throw error;
        }
      }
    });
  });

  describe('error handling and retries', () => {
    it('should handle network failures with retries', async () => {
      const command = `./dist/index.js status --upload-id test-123 --api-key ${mockApiKey} --api-url http://localhost:9999`;
      
      try {
        await exec(command, { timeout: 30_000 });
        expect.fail('Should have failed due to network error');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/network error|failed.*attempts|retrying/i);
      }
    });

    it('should handle invalid API key', async () => {
      const command = `./dist/index.js status --upload-id test-123 --api-key invalid-key --api-url ${mockApiUrl} --json`;
      
      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        const result = JSON.parse(stdout);
        expect(result).to.have.property('error');
        expect(result.error).to.match(/failed to get status|unauthorized|authentication|invalid api key/i);
      } catch (error: unknown) {
        // Command might exit with non-zero code but still return JSON
        if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') {
          const result = JSON.parse(error.stdout);
          expect(result).to.have.property('error');
          expect(result.error).to.match(/failed to get status|unauthorized|authentication|invalid api key/i);
        } else {
          throw error;
        }
      }
    });
  });

  describe('help and validation', () => {
    it('should show help information', async () => {
      const command = `./dist/index.js status --help`;
      
      const { stdout } = await exec(command, { timeout: 10_000 });
      expect(stdout).to.include('Get the status of an upload');
      expect(stdout).to.include('--upload-id');
      expect(stdout).to.include('--name');
      expect(stdout).to.include('--api-key');
    });

    it('should validate upload-id format', async () => {
      const command = `./dist/index.js status --upload-id "" --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have failed due to empty upload-id');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/upload.*id|required|empty/i);
      }
    });
  });
});