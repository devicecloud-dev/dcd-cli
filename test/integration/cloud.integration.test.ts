import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CLI,
  MOCK_API_KEY,
  MOCK_API_URL,
  exec,
  runExpectingFailure,
} from './helpers';

describe('DCD Cloud Command Integration Tests', () => {
  const mockApiUrl = MOCK_API_URL;
  const mockApiKey = MOCK_API_KEY;
  let tempDir: string;
  let outputDir: string;
  let androidAppFile: string;
  let iosAppFile: string;
  let testFlowFile: string;
  let basicConfigFile: string;
  let tagFilteringConfigFile: string;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-test-'));
    // Separate cwd for tests that write output files, so flow-directory tests
    // never pick up JSON artifacts and nothing lands in the repo tree.
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-test-out-'));

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
    for (const dir of [tempDir, outputDir]) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { force: true, recursive: true });
      }
    }
  });

  // The mock API serves Prism example responses, so a successful async run
  // always yields this shape (string-typed example values).
  const expectAsyncRunJson = (stdout: string) => {
    const result = JSON.parse(stdout);
    expect(result).to.have.property('uploadId');
    expect(result.uploadId).to.be.a('string');
    expect(result).to.have.property('status', 'PENDING');
    expect(result).to.have.property('tests');
    expect(result.tests).to.be.an('array').that.is.not.empty;
    return result;
  };

  describe('uploadFlow path', () => {
    it('should successfully upload Android flow with valid parameters', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --async --json`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      expectAsyncRunJson(stdout);
    });

    it('should successfully upload iOS flow with valid parameters', async () => {
      const command = `${CLI} cloud ${iosAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --async --json`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      expectAsyncRunJson(stdout);
    });

    it('should handle invalid app file format', async () => {
      const invalidAppFile = path.join(tempDir, 'invalid-app.txt');
      fs.writeFileSync(invalidAppFile, 'not an app file');

      const command = `${CLI} cloud ${invalidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.match(/App file must be/i);
    });

    it('should validate required flow file parameter', async () => {
      const command = `${CLI} cloud ${androidAppFile} --api-key ${mockApiKey} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('You must provide a flow file');
    });
  });

  describe('authentication path', () => {
    it('should fail without API key', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-url ${mockApiUrl}`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('API key');
    });

    it('should accept API key from environment variable', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-url ${mockApiUrl} --async --json`;

      const { stdout } = await exec(command, {
        env: { ...process.env, DEVICE_CLOUD_API_KEY: mockApiKey },
        timeout: 30_000,
      });
      expectAsyncRunJson(stdout);
    });

    it('should handle authentication failure with invalid API key', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key invalid-key --api-url ${mockApiUrl}`;

      const { code, output } = await runExpectingFailure(command);
      expect(code).to.equal(1);
      // The first authenticated call is the compatibility fetch, which
      // surfaces the mock's 401.
      expect(output).to.include('Failed to fetch device compatibility data');
      expect(output).to.include('401');
    });
  });

  describe('device management path', () => {
    it('should accept valid iOS device configuration', async () => {
      const command = `${CLI} cloud ${iosAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ios-device iphone-14 --ios-version 17 --async --json`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      expectAsyncRunJson(stdout);
    });

    it('should accept valid Android device configuration', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --android-device pixel-7 --android-api-level 34 --async --json`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      expectAsyncRunJson(stdout);
    });

    it('should handle unsupported device configurations', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ios-device unsupported-device --ios-version 99`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('Invalid value for --ios-device');
      expect(output).to.include('unsupported-device');
    });
  });

  describe('device configuration options', () => {
    // Async non-JSON runs always reach submission against the mock API.
    // `.include` keeps these robust to incidental extra lines (e.g. the
    // new-version notice on dev machines).
    const expectAsyncSubmission = (stdout: string) => {
      expect(stdout).to.include('Submitting new job');
      expect(stdout).to.include('Not waiting for results as async flag is set');
    };

    it('should support all Android device options', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --name test-android-devices --async`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectAsyncSubmission(stdout);
    });

    it('should support all iOS device options', async () => {
      const command = `${CLI} cloud ${iosAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --name test-ios-devices --async`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectAsyncSubmission(stdout);
    });

    it('should support device orientation options', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --orientation 90 --name test-orientation --async`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectAsyncSubmission(stdout);
    });

    it('should support device locale configuration', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --device-locale en_US --name test-locale --async`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectAsyncSubmission(stdout);
    });
  });

  describe('advanced execution options', () => {
    const expectAsyncSubmission = (stdout: string) => {
      expect(stdout).to.include('Submitting new job');
      expect(stdout).to.include('Not waiting for results as async flag is set');
    };

    it('should support custom Maestro versions', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --maestro-version 1.39.5 --name test-maestro-version --async`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectAsyncSubmission(stdout);
    });

    it('should support runner type options', async () => {
      const runnerTypes = ['default', 'm4', 'm1'];

      // Run runner type tests sequentially to avoid overwhelming mock API
      for (const runnerType of runnerTypes) {
        const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --runner-type ${runnerType} --android-device pixel-6 --name test-runner-${runnerType} --async`;

        const { stdout } = await exec(command, { timeout: 15_000 });
        expectAsyncSubmission(stdout);
        if (runnerType === 'm4') {
          expect(stdout).to.include('experimental');
        }
      }
    });

    it('should support retry configuration', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --retry 2 --android-device pixel-6 --name test-retry --async`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectAsyncSubmission(stdout);
    });

    it('should limit retry attempts to maximum of 2', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --retry 5 --android-device pixel-6 --async`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('limited to 2');
      expect(stdout).to.include('Submitting new job');
    });

    it('should support report format options', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --report junit --android-device pixel-6 --name test-report --async`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectAsyncSubmission(stdout);
    });
  });

  describe('tag and flow filtering', () => {
    it('should support tag filtering', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --include-tags smoke --exclude-tags slow --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });
  });

  describe('file and binary management', () => {
    it('should support app binary ID instead of file', async () => {
      const command = `${CLI} cloud --app-binary-id test-binary-123 ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });

    it('should support custom config file', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --config ${basicConfigFile} --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
      // Config file should be processed - verify it shows the test flow would run
      expect(stdout).to.include('The following tests would have been run');
      expect(stdout).to.include('test-flow.yaml');
    });

    it('should process config file tag filtering', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --config ${tagFilteringConfigFile} --dry-run`;

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

      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --env ${envFile} --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });
  });

  describe('output and debugging options', () => {
    it('should support quiet mode', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --quiet --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });

    it('should support debug mode', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --debug --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('[DEBUG]');
      expect(stdout).to.include('Dry run mode');
    });

    it('should support JSON output format', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json --async`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expectAsyncRunJson(stdout);
    });

    it('should support custom naming', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --name "My Test Run" --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
    });
  });

  describe('advanced features', () => {
    it('should support Google Play and advanced options', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --google-play --show-crosshairs --dry-run`;

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

      const command = `${CLI} cloud ${androidAppFile} ${testFlowWithOverrides} --api-key ${mockApiKey} --api-url ${mockApiUrl} --debug --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
      expect(stdout).to.include('[DEBUG]');
      // In debug mode, the CLI should show the test file being processed
      expect(stdout).to.include('test-flow-with-overrides.yaml');
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

      const command = `${CLI} cloud ${androidAppFile} ${normalTestFlow} --api-key ${mockApiKey} --api-url ${mockApiUrl} --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
      expect(stdout).to.include('normal-test-flow.yaml');
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
      const command = `${CLI} cloud ${androidAppFile} ${tempDir} --api-key ${mockApiKey} --api-url ${mockApiUrl} --debug --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Dry run mode');
      expect(stdout).to.include('[DEBUG]');

      // Should process all test files
      expect(stdout).to.include('test-with-overrides-1.yaml');
      expect(stdout).to.include('test-with-overrides-2.yaml');
      expect(stdout).to.include('test-no-overrides.yaml');
    });
  });

  describe('json-file-name functionality', () => {
    // These run with cwd: outputDir so the written files are verified and
    // never pollute the repo working tree.
    const readWrittenJson = (filePath: string) => {
      expect(fs.existsSync(filePath), `expected ${filePath} to exist`).to.be
        .true;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    };

    it('should write JSON output to the default file', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json-file --name test-json-default --async`;

      const { stdout } = await exec(command, {
        cwd: outputDir,
        timeout: 15_000,
      });
      expect(stdout).to.include('JSON output will be written to file');

      // Default file name is <uploadId>_dcd.json.
      const written = fs
        .readdirSync(outputDir)
        .filter((f) => f.endsWith('_dcd.json'));
      expect(written).to.have.lengthOf(1);
      const result = readWrittenJson(path.join(outputDir, written[0]));
      expect(result).to.have.property('uploadId');
      expect(result).to.have.property('status', 'PENDING');
    });

    it('should write JSON output to a custom file name', async () => {
      const customJsonFile = 'custom-output.json';
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json-file --json-file-name ${customJsonFile} --name test-json-custom --async`;

      const { stdout } = await exec(command, {
        cwd: outputDir,
        timeout: 15_000,
      });
      expect(stdout).to.include('JSON output will be written to file');

      const result = readWrittenJson(path.join(outputDir, customJsonFile));
      expect(result).to.have.property('uploadId');
    });

    it('should write JSON output to a relative path', async () => {
      const customJsonFile = './output/results.json';
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json-file --json-file-name ${customJsonFile} --name test-json-path --async`;

      const { stdout } = await exec(command, {
        cwd: outputDir,
        timeout: 15_000,
      });
      expect(stdout).to.include('JSON output will be written to file');

      const result = readWrittenJson(
        path.join(outputDir, 'output', 'results.json'),
      );
      expect(result).to.have.property('uploadId');
    });

    it('should fail when json-file-name is used without json-file flag', async () => {
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --json-file-name custom.json`;

      const { output } = await runExpectingFailure(command);
      // Citty port raises a CliError when --json-file-name is used without --json-file.
      expect(output).to.match(/--json-file-name.*--json-file|must also provide/i);
      expect(output).to.include('--json-file');
    });
  });
});
