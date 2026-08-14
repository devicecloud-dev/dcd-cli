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
} from './helpers.js';

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

  // #1105 device matrix: repeated --ios-device-matrix / --android-device-matrix cells.
  describe('device matrix', () => {
    it('accepts a repeated --ios-device-matrix matrix and still yields one upload', async () => {
      const command = `${CLI} cloud ${iosAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ios-device-matrix iphone-16:18 --ios-device-matrix iphone-16-pro:26 --async --json`;

      const { stdout } = await exec(command, { timeout: 30_000 });
      // Still one upload with one uploadId — the matrix is a property of the
      // upload, not N uploads.
      expectAsyncRunJson(stdout);
    });

    it('rejects mixing --ios-device-matrix and --android-device-matrix before any upload', async () => {
      const command = `${CLI} cloud ${iosAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ios-device-matrix iphone-16:18 --android-device-matrix pixel-7:34`;

      const { output } = await runExpectingFailure(command);
      expect(output.toLowerCase()).to.include('cannot mix platforms');
    });

    it('rejects a malformed --ios-device-matrix, naming the value', async () => {
      const command = `${CLI} cloud ${iosAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --ios-device-matrix iphone-16`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('iphone-16');
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
      const command = `${CLI} cloud ${androidAppFile} ${testFlowFile} --api-key ${mockApiKey} --api-url ${mockApiUrl} --maestro-version 2.2.0 --name test-maestro-version --async`;

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

  // Regression cover for dcd-cli#99: config files were excluded from flow
  // discovery by *filename* (literal config.yaml/config.yml plus the exact
  // --config target), so a second workspace config sharing the folder was
  // parsed as a flow and blew up with "Expected an array of steps".
  // These must pass the flow *directory* — the --config tests below pass a
  // single file, which short-circuits into planSingleFile and never reaches
  // flow discovery.
  describe('workspace config discovery', () => {
    let workspaceDir: string;
    let buildConfig: string;
    let updateConfig: string;
    let globConfig: string;

    before(() => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-test-ws-'));

      fs.writeFileSync(
        path.join(workspaceDir, 'flow.yaml'),
        `appId: com.example.app
---
- launchApp
- tapOn: "Login"
`,
      );

      // A genuine flow whose name merely ends in "config.yaml". The old
      // unanchored endsWith() dropped it; it must run.
      fs.writeFileSync(
        path.join(workspaceDir, 'smoke-config.yaml'),
        `appId: com.example.app
name: smoke-config
---
- launchApp
`,
      );

      // Two sibling workspace configs with custom names, as a folder serving
      // several CI workflows would have. Neither is a flow.
      buildConfig = path.join(workspaceDir, 'config_build.yml');
      fs.writeFileSync(
        buildConfig,
        `flows:
  - ./**/*.yaml
includeTags:
  - build
`,
      );

      // Deliberately carries no tag or flow filtering, so when it is the active
      // --config it can't mask the bug by filtering its sibling away first.
      updateConfig = path.join(workspaceDir, 'config_update.yml');
      fs.writeFileSync(
        updateConfig,
        `platform:
  android:
    disableAnimations: true
`,
      );

      globConfig = path.join(workspaceDir, 'config_glob.yml');
      fs.writeFileSync(
        globConfig,
        `flows:
  - ./**/*.yaml
  - ./**/*.yml
`,
      );
    });

    after(() => {
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { force: true, recursive: true });
      }
    });

    it('should ignore sibling config files not named in --config', async () => {
      const command = `${CLI} cloud ${androidAppFile} "${workspaceDir}" --api-key ${mockApiKey} --api-url ${mockApiUrl} --config "${updateConfig}" --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('The following tests would have been run');
      expect(stdout).to.include('flow.yaml');
      expect(stdout).to.not.include('config_build.yml');
      expect(stdout).to.not.include('config_glob.yml');
      expect(stdout).to.not.include('Expected an array of steps');
    });

    it('should ignore config-shaped files when no --config is passed', async () => {
      const command = `${CLI} cloud ${androidAppFile} "${workspaceDir}" --api-key ${mockApiKey} --api-url ${mockApiUrl} --debug --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('flow.yaml');
      expect(stdout).to.include('[DEBUG] Skipping 3 workspace config file(s)');
      expect(stdout).to.not.include('Expected an array of steps');
    });

    it('should ignore config-shaped files matched by a flows glob', async () => {
      const command = `${CLI} cloud ${androidAppFile} "${workspaceDir}" --api-key ${mockApiKey} --api-url ${mockApiUrl} --config "${globConfig}" --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('flow.yaml');
      expect(stdout).to.not.include('config_build.yml');
      expect(stdout).to.not.include('config_update.yml');
      expect(stdout).to.not.include('Expected an array of steps');
    });

    it('should run a flow whose filename merely ends in config.yaml', async () => {
      const command = `${CLI} cloud ${androidAppFile} "${workspaceDir}" --api-key ${mockApiKey} --api-url ${mockApiUrl} --config "${updateConfig}" --dry-run`;

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('smoke-config.yaml');
    });

    it('should reject a custom-named config passed as the flow input', async () => {
      const command = `${CLI} cloud ${androidAppFile} "${buildConfig}" --api-key ${mockApiKey} --api-url ${mockApiUrl} --dry-run`;

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('pass the workspace folder path');
      expect(output).to.not.include('Expected an array of steps');
    });
  });

  // dcd-cli#110: a `config.yaml` whose executionOrder was the wrong *shape* was
  // silently ignored and every flow ran in parallel — same cost, wrong
  // semantics, green run. These assert the shape is now validated.
  describe('executionOrder validation', () => {
    let workspaceDir: string;

    /** Point the run at a workspace whose config.yaml holds `configBody`. */
    const commandWithConfig = (configBody: string): string => {
      fs.writeFileSync(path.join(workspaceDir, 'config.yaml'), configBody);
      return `${CLI} cloud ${androidAppFile} "${workspaceDir}" --api-key ${mockApiKey} --api-url ${mockApiUrl} --dry-run`;
    };

    before(() => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-test-order-'));

      for (const name of ['a', 'b', 'c']) {
        fs.writeFileSync(
          path.join(workspaceDir, `${name}.yaml`),
          `appId: com.example.app
---
- launchApp
`,
        );
      }
    });

    after(() => {
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { force: true, recursive: true });
      }
    });

    it('should reject a bare-list executionOrder instead of running in parallel', async () => {
      const command = commandWithConfig(`executionOrder:
  - a.yaml
  - b.yaml
  - c.yaml
`);

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('Invalid `executionOrder`');
      expect(output).to.include('flowsOrder');
      // The whole point: it must not quietly proceed to a parallel run.
      expect(output).to.not.include('The following tests would have been run');
    });

    it('should reject an executionOrder map with no flowsOrder', async () => {
      const command = commandWithConfig(`executionOrder:
  continueOnFailure: true
`);

      const { output } = await runExpectingFailure(command);
      expect(output).to.include('Invalid `executionOrder`');
      expect(output).to.include('no `flowsOrder` key');
    });

    it('should sequence flows for a well-formed executionOrder', async () => {
      const command = commandWithConfig(`executionOrder:
  continueOnFailure: true
  flowsOrder:
    - a.yaml
    - b.yaml
`);

      const { stdout } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('Sequential flows');
      expect(stdout).to.include('a.yaml');
      expect(stdout).to.include('b.yaml');
    });

    it('should warn about unrecognised config keys without failing the run', async () => {
      const command = commandWithConfig(`flowOrder:
  - a.yaml
flowTimeout: 120000
`);

      const { stdout, stderr } = await exec(command, { timeout: 15_000 });
      expect(stdout).to.include('The following tests would have been run');
      expect(stderr).to.include('flowOrder');
      expect(stderr).to.include('executionOrder.flowsOrder');
      expect(stderr).to.include('flowTimeout');
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
