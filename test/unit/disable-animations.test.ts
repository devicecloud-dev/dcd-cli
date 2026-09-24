import { expect } from 'chai';
import { parseArgs } from 'citty';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deviceFlags } from '../../src/config/flags/device.flags.js';
import type { IExecutionPlan } from '../../src/services/execution-plan.service.js';
import { platformFromAppFile } from '../../src/services/notices.service.js';
import {
  type TestSubmissionConfig,
  TestSubmissionService,
} from '../../src/services/test-submission.service.js';

/**
 * config.yaml can set `platform.ios.disableAnimations` and
 * `platform.android.disableAnimations` separately. Which one applies must
 * follow the app actually being tested, and an explicit
 * --disable-animations / --no-disable-animations must beat either.
 */
describe('disableAnimations', () => {
  let workspace: string;
  let flowFile: string;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-animations-'));
    flowFile = path.join(workspace, 'flow.yaml');
    fs.writeFileSync(flowFile, 'appId: com.example\n---\n- launchApp\n');
  });

  after(() => {
    fs.rmSync(workspace, { force: true, recursive: true });
  });

  /** The disableAnimations value the payload's config carries. */
  async function sent(
    overrides: Partial<TestSubmissionConfig>,
    platform = { android: { disableAnimations: false }, ios: { disableAnimations: true } },
  ): Promise<unknown> {
    const executionPlan: IExecutionPlan = {
      flowMetadata: {},
      flowOverrides: {},
      flowsToRun: [flowFile],
      includedFiles: [],
      referencedFiles: [],
      totalFlowFiles: 1,
      workspaceConfig: { platform },
    };
    const { fields } = await new TestSubmissionService().buildTestPayload({
      appBinaryId: 'binary-1',
      cliVersion: '0.0.0-test',
      commonRoot: workspace,
      executionPlan,
      flowFile,
      maestroVersion: '2.10.0',
      ...overrides,
    });
    return (JSON.parse(fields.config) as { disableAnimations?: unknown })
      .disableAnimations;
  }

  describe('which platform block of config.yaml applies', () => {
    it('follows an iOS binary even without --ios-device / --ios-version', async () => {
      // Used to read the android block here, because only the iOS flags
      // marked a run as iOS.
      expect(await sent({ appPlatform: 'ios' })).to.equal(true);
    });

    it('follows an Android binary even when an iOS flag is present', async () => {
      expect(await sent({ appPlatform: 'android', iOSVersion: '18' })).to.equal(false);
    });

    it('falls back to the iOS flags when the binary is unknown (--app-binary-id)', async () => {
      expect(await sent({ iOSDevice: 'iphone-16' })).to.equal(true);
      expect(await sent({})).to.equal(false);
    });

    it('falls back to a device matrix when the binary is unknown', async () => {
      expect(
        await sent({ deviceMatrix: [{ iOSDevice: 'iphone-16', iOSVersion: '18' }] }),
      ).to.equal(true);
    });
  });

  describe('an explicit flag', () => {
    it('keeps animations on against the config (--no-disable-animations)', async () => {
      expect(await sent({ appPlatform: 'ios', disableAnimations: false })).to.equal(false);
    });

    it('turns animations off against the config (--disable-animations)', async () => {
      expect(await sent({ appPlatform: 'android', disableAnimations: true })).to.equal(true);
    });

    it('leaves the config in charge when not passed', async () => {
      const androidOff = {
        android: { disableAnimations: true },
        ios: { disableAnimations: false },
      };
      expect(await sent({ appPlatform: 'android' }, androidOff)).to.equal(true);
    });
  });

  describe('the --disable-animations flag', () => {
    const parse = (argv: string[]) => parseArgs(argv, deviceFlags)['disable-animations'];

    it('is undefined when not passed, so the config can apply', () => {
      expect(parse([])).to.equal(undefined);
    });

    it('is true or false when passed either way', () => {
      expect(parse(['--disable-animations'])).to.equal(true);
      expect(parse(['--no-disable-animations'])).to.equal(false);
    });
  });

  describe('platformFromAppFile', () => {
    it('reads the platform from the app file', () => {
      expect(platformFromAppFile('build/app.apk')).to.equal('android');
      expect(platformFromAppFile('build/App.app')).to.equal('ios');
      expect(platformFromAppFile('build/app.zip')).to.equal('ios');
      expect(platformFromAppFile('build/expo-build.tar.gz')).to.equal('ios');
      expect(platformFromAppFile('https://expo.dev/build.tar.gz?token=x')).to.equal('ios');
    });

    it('does not guess from a flow path or nothing', () => {
      expect(platformFromAppFile('flows/login.yaml')).to.equal(undefined);
      expect(platformFromAppFile(undefined)).to.equal(undefined);
    });
  });
});
