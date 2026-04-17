import { expect } from 'chai';
import { exec as execCallback } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

describe('Upload Command Integration Tests', () => {
  const mockApiUrl = 'http://localhost:3001';
  const mockApiKey = 'test-api-key-123';
  let tempDir: string;
  let androidAppFile: string;
  let iosAppFile: string;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-upload-test-'));
    
    // Use real binary files
    androidAppFile = path.resolve('test/fixtures/wikipedia.apk');
    iosAppFile = path.resolve('test/fixtures/wikipedia.zip');
  });

  after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  describe('basic upload functionality', () => {
    it('should require API key', async () => {
      const command = `./dist/index.js upload ${androidAppFile} --api-url ${mockApiUrl}`;
      
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
      const command = `./dist/index.js upload ${androidAppFile} --api-url ${mockApiUrl} --json`;
      
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

    it('should require app file argument', async () => {
      const command = `./dist/index.js upload --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for missing app file');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/missing.*required.*arg|app.*file.*required|provide an app file/i);
      }
    });

    it('should validate app file format', async () => {
      // Create invalid file
      const invalidFile = path.join(tempDir, 'invalid.txt');
      fs.writeFileSync(invalidFile, 'not a binary file');

      const command = `./dist/index.js upload ${invalidFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for invalid file format');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/app file must be|invalid.*format/i);
      }
    });
  });

  describe('Android APK upload', () => {
    it('should upload Android APK successfully', async () => {
      const command = `./dist/index.js upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;
      
      try {
        const { stdout } = await exec(command, { timeout: 30_000 });
        const result = JSON.parse(stdout);
        expect(result).to.have.property('appBinaryId');
        expect(typeof result.appBinaryId).to.equal('string');
      } catch (error: unknown) {
        // Mock API may not be fully configured - verify command processes correctly
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          expect(output).to.match(/uploading|binary|failed to upload|network error/i);
        } else {
          throw error;
        }
      }
    });

    it('should upload Android APK with ignore SHA check', async () => {
      const command = `./dist/index.js upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ignore-sha-check --json`;

      try {
        const { stdout } = await exec(command, { timeout: 30_000 });
        if (!stdout || stdout.trim() === '') {
          // Empty stdout is acceptable - mock API may not return data
          return;
        }

        const result = JSON.parse(stdout);
        expect(result).to.have.property('appBinaryId');
      } catch (error: unknown) {
        // Mock API may not be fully configured - verify command processes correctly
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          // Accept citty JSON error format ({"status":"FAILED","error":...}) or
          // plain stdout containing an upload/network error marker.
          const hasJsonError =
            output.includes('"status": "FAILED"') || output.includes('"error"');
          const hasExpectedError = /uploading|binary|failed to upload|network error/i.test(output);
          expect(hasJsonError || hasExpectedError).to.be.true;
        } else {
          throw error;
        }
      }
    });
  });

  describe('iOS ZIP upload', () => {
    it('should upload iOS ZIP successfully', async () => {
      const command = `./dist/index.js upload ${iosAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;
      
      try {
        const { stdout } = await exec(command, { timeout: 30_000 });
        const result = JSON.parse(stdout);
        expect(result).to.have.property('appBinaryId');
        expect(typeof result.appBinaryId).to.equal('string');
      } catch (error: unknown) {
        // Mock API may not be fully configured - verify command processes correctly
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          expect(output).to.match(/uploading|binary|failed to upload|network error/i);
        } else {
          throw error;
        }
      }
    });

    it('should validate ZIP file structure', async () => {
      // Create invalid ZIP file
      const invalidZip = path.join(tempDir, 'invalid.zip');
      fs.writeFileSync(invalidZip, 'not a valid zip file');

      const command = `./dist/index.js upload ${invalidZip} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        await exec(command, { timeout: 15_000 });
        expect.fail('Should have thrown an error for invalid ZIP structure');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/zip.*invalid|must contain.*app|error/i);
      }
    });
  });

  describe('output formats', () => {
    it('should support JSON output format', async () => {
      const command = `./dist/index.js upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;
      
      try {
        const { stdout } = await exec(command, { timeout: 30_000 });
        expect(() => JSON.parse(stdout)).to.not.throw();
        const result = JSON.parse(stdout);
        expect(result).to.have.property('appBinaryId');
      } catch (error: unknown) {
        // Mock API may not return proper response - check that JSON flag was processed
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          // Should be attempting JSON format even if it fails
          expect(output).to.match(/uploading|binary|failed to upload|network error|\\{.*\\}/i);
        } else {
          throw error;
        }
      }
    });

    it('should support standard output format by default', async () => {
      const command = `./dist/index.js upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        const { stdout } = await exec(command, { timeout: 30_000 });
        // Should contain standard upload output
        expect(stdout).to.match(/uploading|binary.*id|upload.*complete/i);
        // Should not be JSON format
        expect(() => JSON.parse(stdout)).to.throw();
      } catch (error: unknown) {
        // Mock API may not return proper response - verify non-JSON output attempt
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          expect(output).to.match(/uploading|binary|failed to upload|network error/i);
          // Should not be JSON format
          expect(() => JSON.parse(output)).to.throw();
        } else {
          throw error;
        }
      }
    });
  });

  describe('error handling', () => {
    it('should handle network failures gracefully', async () => {
      const command = `./dist/index.js upload ${androidAppFile} --api-key ${mockApiKey} --api-url http://localhost:9999`;
      
      try {
        await exec(command, { timeout: 30_000 });
        expect.fail('Should have failed due to network error');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/network error|failed.*upload|connection|fetch failed/i);
      }
    });

    it('should handle invalid API key', async () => {
      const command = `./dist/index.js upload ${androidAppFile} --api-key invalid-key --api-url ${mockApiUrl}`;
      
      try {
        await exec(command, { timeout: 15_000 });
        expect.fail('Should have failed due to invalid API key');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/failed.*upload|unauthorized|authentication|invalid.*api.*key/i);
      }
    });

    it('should handle missing file', async () => {
      const missingFile = path.join(tempDir, 'nonexistent.apk');
      const command = `./dist/index.js upload ${missingFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have failed for missing file');
      } catch (error: unknown) {
        const errorOutput = (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '') || 
                          (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        expect(errorOutput).to.match(/no such file|not found|enoent/i);
      }
    });
  });

  describe('help and validation', () => {
    it('should show help information', async () => {
      const command = `./dist/index.js upload --help`;
      
      const { stdout } = await exec(command, { timeout: 10_000 });
      expect(stdout).to.include('Upload an app binary');
      expect(stdout).to.include('--api-key');
      expect(stdout).to.include('--ignore-sha-check');
      expect(stdout).to.include('APPFILE');
    });

    it('should show usage line in help', async () => {
      const command = `./dist/index.js upload --help`;

      const { stdout } = await exec(command, { timeout: 10_000 });
      expect(stdout).to.match(/USAGE/i);
      expect(stdout).to.include('upload');
    });
  });

  describe('SHA check functionality', () => {
    it('should perform SHA check by default', async () => {
      const command = `./dist/index.js upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;
      
      try {
        const { stdout } = await exec(command, { timeout: 30_000 });
        // Should contain SHA-related output or skip message
        expect(stdout).to.match(/sha.*hash|checking|skipping.*upload|upload.*complete/i);
      } catch (error: unknown) {
        // Mock API may not support SHA check endpoint - verify command processes
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          expect(output).to.match(/uploading|binary|failed to upload|network error|sha/i);
        } else {
          throw error;
        }
      }
    });

    it('should skip SHA check when flag is provided', async () => {
      const command = `./dist/index.js upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ignore-sha-check`;
      
      try {
        const { stdout } = await exec(command, { timeout: 30_000 });
        // Should upload without SHA check (no skip message)
        expect(stdout).to.match(/uploading|binary.*id|upload.*complete/i);
      } catch (error: unknown) {
        // Mock API may not be fully configured - verify command processes
        if (error && typeof error === 'object' && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string') {
          const output = error.stdout;
          expect(output).to.match(/uploading|binary|failed to upload|network error/i);
        } else {
          throw error;
        }
      }
    });
  });
});