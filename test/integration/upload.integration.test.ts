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
} from './helpers';

describe('Upload Command Integration Tests', () => {
  const mockApiUrl = MOCK_API_URL;
  const mockApiKey = MOCK_API_KEY;
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

  // Against the mock API the SHA dedup check always matches (Prism example
  // response), so a default upload short-circuits to an existing binary id.
  const expectUploadJson = (stdout: string) => {
    const result = JSON.parse(stdout);
    expect(result).to.have.property('appBinaryId');
    expect(result.appBinaryId).to.be.a('string');
    return result;
  };

  describe('basic upload functionality', () => {
    it('should require API key', async () => {
      const command = `${CLI} upload ${androidAppFile} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('API key');
    });

    it('should accept API key from environment variable', async () => {
      const command = `${CLI} upload ${androidAppFile} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, {
        env: { ...process.env, DEVICE_CLOUD_API_KEY: mockApiKey },
        timeout: 15_000,
      });
      expectUploadJson(stdout);
    });

    it('should require app file argument', async () => {
      const command = `${CLI} upload --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('You must provide an app file');
    });

    it('should validate app file format', async () => {
      // Create invalid file
      const invalidFile = path.join(tempDir, 'invalid.txt');
      fs.writeFileSync(invalidFile, 'not a binary file');

      const command = `${CLI} upload ${invalidFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.match(/App file must be/i);
    });
  });

  describe('Android APK upload', () => {
    it('should upload Android APK successfully', async () => {
      const command = `${CLI} upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      expectUploadJson(stdout);
    });
  });

  describe('iOS ZIP upload', () => {
    it('should upload iOS ZIP successfully', async () => {
      const command = `${CLI} upload ${iosAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      expectUploadJson(stdout);
    });

    it('should validate ZIP file structure', async () => {
      // Create invalid ZIP file
      const invalidZip = path.join(tempDir, 'invalid.zip');
      fs.writeFileSync(invalidZip, 'not a valid zip file');

      const command = `${CLI} upload ${invalidZip} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      // node-stream-zip rejects the corrupt archive before any upload starts.
      expect(output).to.include('Bad archive');
    });
  });

  describe('output formats', () => {
    it('should support JSON output format', async () => {
      const command = `${CLI} upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      expectUploadJson(stdout);
    });

    it('should support standard output format by default', async () => {
      const command = `${CLI} upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      expect(stdout).to.include('Upload complete');
      expect(stdout).to.include('Binary ID');
      expect(stdout).to.include('dcd cloud --app-binary-id');
      // Should not be JSON format
      expect(() => JSON.parse(stdout)).to.throw();
    });
  });

  describe('error handling', () => {
    it('should handle network failures gracefully', async () => {
      const command = `${CLI} upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${DEAD_API_URL}`;

      const { code, output } = await runExpectingFailure(command, {
        timeout: 30_000,
      });
      expect(code).to.equal(1);
      expect(output).to.include('Network request failed');
    });

    it('should handle invalid API key', async () => {
      const command = `${CLI} upload ${androidAppFile} --api-key invalid-key --api-url ${mockApiUrl}`;

      const { code, output } = await runExpectingFailure(command);
      expect(code).to.equal(1);
      // The 401 from the SHA dedup check aborts before any upload starts.
      expect(output).to.include('Authentication failed');
    });

    it('should handle missing file', async () => {
      const missingFile = path.join(tempDir, 'nonexistent.apk');
      const command = `${CLI} upload ${missingFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.match(/ENOENT|no such file/i);
    });
  });

  describe('help and validation', () => {
    it('should show help information', async () => {
      const command = `${CLI} upload --help`;

      const { stdout } = await exec(command, { timeout: 10_000 });
      expect(stdout).to.include('Upload an app binary');
      expect(stdout).to.include('--api-key');
      expect(stdout).to.include('--ignore-sha-check');
      expect(stdout).to.include('APPFILE');
    });

    it('should show usage line in help', async () => {
      const command = `${CLI} upload --help`;

      const { stdout } = await exec(command, { timeout: 10_000 });
      expect(stdout).to.match(/USAGE/i);
      expect(stdout).to.include('upload');
    });
  });

  describe('SHA check functionality', () => {
    it('should perform SHA check by default and skip the upload on a match', async () => {
      const command = `${CLI} upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      // The mock's checkForExistingUpload always reports a match.
      expect(stdout).to.include('SHA hash matches existing binary');
      expect(stdout).to.include('skipping upload');
    });

    it('should attempt a real upload when the SHA check is bypassed', async () => {
      const command = `${CLI} upload ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ignore-sha-check --json`;

      // Bypassing dedup makes the CLI upload to the storage URLs from the
      // mock's example response, which point at real (unwritable) hosts —
      // so this deterministically fails after attempting every upload path.
      // It still verifies --ignore-sha-check skips the dedup short-circuit.
      const { code, stdout } = await runExpectingFailure(command, {
        timeout: 60_000,
      });
      expect(code).to.equal(1);
      const result = JSON.parse(stdout);
      expect(result).to.have.property('status', 'FAILED');
      expect(result.error).to.include('All uploads failed');
    });
  });
});
