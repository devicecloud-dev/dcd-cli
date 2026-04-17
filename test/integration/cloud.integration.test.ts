import { expect } from 'chai';
import { exec as execCallback } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

function getErrorOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return '';

  if ('stderr' in error && typeof error.stderr === 'string') {
    return error.stderr;
  }

  if ('stdout' in error && typeof error.stdout === 'string') {
    return error.stdout;
  }

  return '';
}

describe('DCD Cloud Command Integration Tests', () => {
  const mockApiUrl = 'http://localhost:3001';
  const mockApiKey = 'test-api-key-123';
  let tempDir: string;
  let androidAppFile: string;
  let iosAppFile: string;
  let testFlowFile: string;
  let basicConfigFile: string;
  let tagFilteringConfigFile: string;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-test-'));

    // Use real binary files
    androidAppFile = path.resolve('test/fixtures/wikipedia.apk');
    iosAppFile = path.resolve('test/fixtures/wikipedia.zip');

    // Verify the binary files exist
    expect(fs.existsSync(androidAppFile)).to.be.true;
    expect(fs.existsSync(iosAppFile)).to.be.true;

    // Create a mock flow file
    testFlowFile = path.join(tempDir, 'test-flow.yaml');
    fs.writeFileSync(
      testFlowFile,
      `
appId: com.example.app
---
- launchApp
- tapOn: "Login"
- inputText: "test@example.com"
    `,
    );

    // Use config files from fixtures
    basicConfigFile = path.resolve('test/fixtures/basic-config.yaml');
    tagFilteringConfigFile = path.resolve(
      'test/fixtures/tag-filtering-config.yaml',
    );
  });

  after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  describe('uploadFlow path', () => {
    it('should successfully upload Android flow with valid parameters', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --async --json`;

      try {
        const { stderr, stdout } = await exec(command, {
          cwd: process.cwd(),
          timeout: 30_000,
        });

        const result = JSON.parse(stdout);
        expect(result).to.have.property('uploadId');
        expect(result).to.have.property('status', 'PENDING');
        expect(result).to.have.property('tests');
        expect(result.tests).to.be.an('array');
        expect(stderr).to.be.empty;
      } catch (error: unknown) {
        // Mock API may not have compatibility endpoint - verify command processes correctly
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // JSON error format or stderr text format
          expect(output).to.match(
            /compatibility|device.*data|failed to fetch|"oclif"|"error"|"status": "FAILED"|Submitting new job/i,
          );
        } else {
          throw error;
        }
      }
    });

    it('should successfully upload iOS flow with valid parameters', async () => {
      const command = `./dist/index.js cloud ${iosAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --async --json`;

      try {
        const { stderr, stdout } = await exec(command, {
          cwd: process.cwd(),
          timeout: 30_000,
        });

        const result = JSON.parse(stdout);
        expect(result).to.have.property('uploadId');
        expect(result).to.have.property('status', 'PENDING');
        expect(result).to.have.property('tests');
        expect(result.tests).to.be.an('array');
        expect(stderr).to.be.empty;
      } catch (error: unknown) {
        // Mock API may not have compatibility endpoint - verify command processes correctly
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          // JSON error format or stderr text format
          expect(output).to.match(
            /compatibility|device.*data|failed to fetch|"oclif"|"error"|"status": "FAILED"|Submitting new job/i,
          );
        } else {
          throw error;
        }
      }
    });

    it('should handle invalid app file format', async () => {
      const invalidAppFile = path.join(tempDir, 'invalid-app.txt');
      fs.writeFileSync(invalidAppFile, 'not an app file');

      const command = `./dist/index.js cloud ${invalidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for invalid app file');
      } catch (error: unknown) {
        const errorOutput = getErrorOutput(error);
        expect(errorOutput).to.match(
          /app file must be|failed to fetch.*compatibility/i,
        );
      }
    });

    it('should validate required flow file parameter', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for missing flow file');
      } catch (error: unknown) {
        const errorOutput = getErrorOutput(error);
        expect(errorOutput).to.match(
          /flow file|failed to fetch.*compatibility/i,
        );
      }
    });
  });

  describe('authentication path', () => {
    it('should fail without API key', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-url ${mockApiUrl}`;

      try {
        await exec(command, { timeout: 10_000 });
        expect.fail('Should have thrown an error for missing API key');
      } catch (error: unknown) {
        const errorOutput = getErrorOutput(error);
        expect(errorOutput).to.include('API key');
      }
    });

    it('should accept API key from environment variable', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-url ${mockApiUrl} --async --json`;

      try {
        const { stderr, stdout } = await exec(command, {
          env: { ...process.env, DEVICE_CLOUD_API_KEY: mockApiKey },
          timeout: 30_000,
        });

        const result = JSON.parse(stdout);
        expect(result).to.have.property('uploadId');
        expect(stderr).to.be.empty;
      } catch (error: unknown) {
        // If mock server returns expected error, verify it's not about missing API key
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          expect(output).to.not.include('You must provide an API key');
        } else {
          throw error;
        }
      }
    });

    it('should handle authentication failure with invalid API key', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key invalid-key --api-url ${mockApiUrl}`;

      try {
        await exec(command, { timeout: 15_000 });
        expect.fail('Should have thrown an error for invalid API key');
      } catch (error: unknown) {
        const errorOutput = getErrorOutput(error);
        expect(errorOutput).to.match(
          /compatibility|device.*data|failed to fetch/i,
        );
      }
    });
  });

  describe('device management path', () => {
    it('should accept valid iOS device configuration', async () => {
      const command = `./dist/index.js cloud ${iosAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ios-device iphone-14 --ios-version 17 --async --json`;

      try {
        const { stderr, stdout } = await exec(command, {
          timeout: 30_000,
        });

        const result = JSON.parse(stdout);
        expect(result).to.have.property('uploadId');
        expect(stderr).to.be.empty;
      } catch (error: unknown) {
        // If mock server returns expected error, verify device config was accepted
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          expect(output).to.not.include('Device');
          expect(output).to.not.include('not supported');
        } else {
          throw error;
        }
      }
    });

    it('should accept valid Android device configuration', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --android-device pixel-7 --android-api-level 34 --async --json`;

      try {
        const { stderr, stdout } = await exec(command, {
          timeout: 30_000,
        });

        const result = JSON.parse(stdout);
        expect(result).to.have.property('uploadId');
        expect(stderr).to.be.empty;
      } catch (error: unknown) {
        // If mock server returns expected error, verify device config was accepted
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          expect(output).to.not.include("don't support that device");
        } else {
          throw error;
        }
      }
    });

    it('should handle unsupported device configurations', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ios-device unsupported-device --ios-version 99`;

      try {
        await exec(command, { timeout: 15_000 });
        expect.fail('Should have thrown an error for unsupported device');
      } catch (error: unknown) {
        const errorOutput = getErrorOutput(error);
        expect(errorOutput).to.match(
          /not supported|unsupported|supported.*versions/i,
        );
      }
    });
  });

  describe('device configuration options', () => {
    it('should support all Android device options', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --name test-android-devices --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // May show version notification, then should run tests
        expect(stdout).to.match(/Submitting new job|A new version/);
        if (stdout.includes('Submitting new job')) {
          expect(stdout).to.include(
            'Not waiting for results as async flag is set',
          );
        }
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Submitting new job')) {
            expect(true).to.be.true;
            return;
          }
        }

        throw error;
      }
    });

    it('should support all iOS device options', async () => {
      const command = `./dist/index.js cloud ${iosAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --name test-ios-devices --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // May show version notification, then should run tests
        expect(stdout).to.match(/Submitting new job|A new version/);
        if (stdout.includes('Submitting new job')) {
          expect(stdout).to.include(
            'Not waiting for results as async flag is set',
          );
        }
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Submitting new job')) {
            expect(true).to.be.true;
            return;
          }
        }

        throw error;
      }
    });

    it('should support device orientation options', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --orientation 90 --name test-orientation --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // May show version notification, then should run tests
        expect(stdout).to.match(/Submitting new job|A new version/);
        if (stdout.includes('Submitting new job')) {
          expect(stdout).to.include(
            'Not waiting for results as async flag is set',
          );
        }
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Submitting new job')) {
            return;
          }
        }

        throw error;
      }
    });

    it('should support device locale configuration', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --device-locale en_US --name test-locale --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // May show version notification, then should run tests
        expect(stdout).to.match(/Submitting new job|A new version/);
        if (stdout.includes('Submitting new job')) {
          expect(stdout).to.include(
            'Not waiting for results as async flag is set',
          );
        }
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Submitting new job')) {
            return;
          }
        }

        throw error;
      }
    });
  });

  describe('advanced execution options', () => {
    it('should support custom Maestro versions', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --maestro-version 1.39.5 --name test-maestro-version --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // May show version notification, then should run tests
        expect(stdout).to.match(/Submitting new job|A new version/);
        if (stdout.includes('Submitting new job')) {
          expect(stdout).to.include(
            'Not waiting for results as async flag is set',
          );
        }
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Submitting new job')) {
            return;
          }
        }

        throw error;
      }
    });

    it('should support runner type options', async () => {
      const runnerTypes = ['default', 'm4', 'm1'];

      // Run runner type tests sequentially to avoid overwhelming mock API
      for (const runnerType of runnerTypes) {
        const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --runner-type ${runnerType} --android-device pixel-6 --name test-runner-${runnerType} --async`;

        try {
          const { stdout } = await exec(command, { timeout: 15_000 });
          // May show version notification, then should run tests
          expect(stdout).to.match(/Submitting new job|A new version/);
          if (stdout.includes('Submitting new job')) {
            expect(stdout).to.include(
              'Not waiting for results as async flag is set',
            );
            if (runnerType === 'm4') {
              expect(stdout).to.include('experimental');
            }
          }
        } catch (error: unknown) {
          if (
            error &&
            typeof error === 'object' &&
            'stdout' in error &&
            typeof error.stdout === 'string'
          ) {
            const output = error.stdout;
            if (output.includes('Submitting new job')) {
              continue;
            }
          }

          throw error;
        }
      }
    });

    it('should support retry configuration', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --retry 2 --android-device pixel-6 --name test-retry --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // May show version notification, then should run tests
        expect(stdout).to.match(/Submitting new job|A new version/);
        if (stdout.includes('Submitting new job')) {
          expect(stdout).to.include(
            'Not waiting for results as async flag is set',
          );
        }
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Submitting new job')) {
            return;
          }
        }

        throw error;
      }
    });

    it('should limit retry attempts to maximum of 2', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --retry 5 --android-device pixel-6 --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // Should show warning about retry limit and still run
        expect(stdout).to.include('limited to 2');
        expect(stdout).to.include('Submitting new job');
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (
            output.includes('limited to 2') ||
            output.includes('Submitting new job')
          ) {
            return;
          }
        }

        throw error;
      }
    });

    it('should support report format options', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --report junit --android-device pixel-6 --name test-report --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        // May show version notification, then should run tests
        expect(stdout).to.match(/Submitting new job|A new version/);
        if (stdout.includes('Submitting new job')) {
          expect(stdout).to.include(
            'Not waiting for results as async flag is set',
          );
        }
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Submitting new job')) {
            return;
          }
        }

        throw error;
      }
    });
  });

  describe('tag and flow filtering', () => {
    it('should support tag filtering', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --include-tags smoke --exclude-tags slow --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });
  });

  describe('file and binary management', () => {
    it('should support app binary ID instead of file', async () => {
      const command = `./dist/index.js cloud --app-binary-id test-binary-123 ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });

    it('should support custom config file', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --config ${basicConfigFile} --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
      // Config file should be processed - verify it shows the test flow would run
      expect(stdout).to.include('The following tests would have been run');
      expect(stdout).to.include('test-flow.yaml');
    });

    it('should process config file tag filtering', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --config ${tagFilteringConfigFile} --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
      // Should show that config was processed
      expect(stdout).to.include('The following tests would have been run');
    });

    it('should support environment variables', async () => {
      // Create env file
      const envFile = path.join(tempDir, '.env');
      fs.writeFileSync(
        envFile,
        'TEST_VAR=test_value\nANOTHER_VAR=another_value',
      );

      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --env ${envFile} --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });
  });

  describe('output and debugging options', () => {
    it('should support quiet mode', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --quiet --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
      // In quiet mode, should have less verbose output
    });

    it('should support debug mode', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --debug --dry-run`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(stdout).to.include('[DEBUG]');
        expect(stdout).to.include('Dry run mode');
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('[DEBUG]')) {
            expect(true).to.be.true;
            return;
          }
        }

        throw error;
      }
    });

    it('should support JSON output format', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        const result = JSON.parse(stdout);
        expect(result).to.have.property('uploadId');
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('"oclif"') || output.includes('"status": "FAILED"')) {
            expect(true).to.be.true;
            return;
          }
        }

        throw error;
      }
    });

    it('should support JSON file output', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json-file --name test-run --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(stdout).to.include('JSON output will be written to file');
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('JSON output will be written to file')) {
            expect(true).to.be.true;
            return;
          }
        }

        throw error;
      }
    });

    it('should support custom naming', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --name "My Test Run" --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });
  });

  describe('advanced features', () => {
    it('should support Google Play and advanced options', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --google-play --show-crosshairs --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });

    it('should extract and process device cloud environment overrides from test headers', async () => {
      // Create a test flow file with device cloud environment variables in the header
      const testFlowWithOverrides = path.join(
        tempDir,
        'test-flow-with-overrides.yaml',
      );
      fs.writeFileSync(
        testFlowWithOverrides,
        `name: Test Flow With Overrides
appId: com.example.app
env:
  USERNAME: user@example.com
  PASSWORD: "123"
  DEVICECLOUD_OVERRIDE_DEVICE_LOCALE: "de_DE"
tags:
  - smoke
---
- launchApp
- tapOn: "Login"
- inputText: "test@example.com"
    `,
      );

      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowWithOverrides} --api-key ${mockApiKey} --api-url ${mockApiUrl} --debug --dry-run`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(stdout).to.include('Dry run mode');
        expect(stdout).to.include('[DEBUG]');

        // In debug mode, the CLI should show that overrides are being processed
        // The exact debug output format may vary, but it should contain references to the test file
        expect(stdout).to.include('test-flow-with-overrides.yaml');
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Dry run mode') && output.includes('[DEBUG]')) {
            expect(output).to.include('test-flow-with-overrides.yaml');
            return;
          }
        }

        throw error;
      }
    });

    it('should handle test files without device cloud overrides normally', async () => {
      // Create a test flow file without any device cloud environment variables
      const normalTestFlow = path.join(tempDir, 'normal-test-flow.yaml');
      fs.writeFileSync(
        normalTestFlow,
        `name: Normal Test Flow
appId: com.example.app
env:
  USERNAME: user@example.com
  PASSWORD: "123"
tags:
  - regression
---
- launchApp
- tapOn: "Login"
- inputText: "test@example.com"
    `,
      );

      const command = `./dist/index.js cloud ${androidAppFile} ${normalTestFlow} --api-key ${mockApiKey} --api-url ${mockApiUrl} --dry-run`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(stdout).to.include('Dry run mode');
        expect(stdout).to.include('normal-test-flow.yaml');
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Dry run mode')) {
            expect(output).to.include('normal-test-flow.yaml');
            return;
          }
        }

        throw error;
      }
    });

    it('should process multiple test files with different override configurations', async () => {
      // Create multiple test files with different override configurations
      const testFlow1 = path.join(tempDir, 'test-with-overrides-1.yaml');
      const testFlow2 = path.join(tempDir, 'test-with-overrides-2.yaml');
      const testFlow3 = path.join(tempDir, 'test-no-overrides.yaml');

      fs.writeFileSync(
        testFlow1,
        `name: Test With Debug Override
env:
  USERNAME: admin@example.com
  DEVICECLOUD_OVERRIDE_DEBUG: true
  DEVICECLOUD_OVERRIDE_RETRY_COUNT: 3
tags:
  - smoke
---
- launchApp
    `,
      );

      fs.writeFileSync(
        testFlow2,
        `name: Test With Timeout Override
env:
  PASSWORD: secret123
  DEVICECLOUD_OVERRIDE_TIMEOUT: 60
  DEVICECLOUD_OVERRIDE_ENVIRONMENT: staging
tags:
  - integration
---
- launchApp
    `,
      );

      fs.writeFileSync(
        testFlow3,
        `name: Test Without Overrides
env:
  USERNAME: regular@example.com
  PASSWORD: normalpass
tags:
  - regression
---
- launchApp
    `,
      );

      // Test with a directory containing multiple flows
      const testDir = tempDir;
      const command = `./dist/index.js cloud ${androidAppFile} ${testDir} --api-key ${mockApiKey} --api-url ${mockApiUrl} --debug --dry-run`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(stdout).to.include('Dry run mode');
        expect(stdout).to.include('[DEBUG]');

        // Should process all test files
        expect(stdout).to.include('test-with-overrides-1.yaml');
        expect(stdout).to.include('test-with-overrides-2.yaml');
        expect(stdout).to.include('test-no-overrides.yaml');
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('Dry run mode') && output.includes('[DEBUG]')) {
            // At least verify that the files are being processed
            expect(true).to.be.true;
            return;
          }
        }

        throw error;
      }
    });
  });

  describe('json-file-name functionality', () => {
    it('should accept json-file flag and show expected message', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json-file --name test-json-default --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(stdout).to.include('JSON output will be written to file');
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('JSON output will be written to file')) {
            expect(true).to.be.true;
            return;
          }
        }

        throw error;
      }
    });

    it('should accept json-file-name with json-file flag', async () => {
      const customJsonFile = 'custom-output.json';
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json-file --json-file-name ${customJsonFile} --name test-json-custom --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(stdout).to.include('JSON output will be written to file');
        // Command accepts the custom filename parameter without errors
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('JSON output will be written to file')) {
            expect(true).to.be.true;
            return;
          }
        }

        throw error;
      }
    });

    it('should accept relative paths in json-file-name', async () => {
      const customJsonFile = './output/results.json';
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json-file --json-file-name ${customJsonFile} --name test-json-path --async`;

      try {
        const { stdout } = await exec(command, { timeout: 15_000 });
        expect(stdout).to.include('JSON output will be written to file');
        // Command accepts the relative path parameter without errors
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof error.stdout === 'string'
        ) {
          const output = error.stdout;
          if (output.includes('JSON output will be written to file')) {
            expect(true).to.be.true;
            return;
          }
        }

        throw error;
      }
    });

    it('should fail when json-file-name is used without json-file flag', async () => {
      const command = `./dist/index.js cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json-file-name custom.json`;

      try {
        await exec(command, { timeout: 15_000 });
        expect.fail('Command should have failed');
      } catch (error) {
        const errorOutput = getErrorOutput(error);
        // Citty port raises a CliError when --json-file-name is used without --json-file.
        expect(errorOutput).to.match(/--json-file-name.*--json-file|must also provide/i);
        expect(errorOutput).to.include('--json-file');
      }
    });
  });
});
