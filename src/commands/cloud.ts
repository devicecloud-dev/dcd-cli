/* eslint-disable complexity */
import { defineCommand } from 'citty';
import * as path from 'node:path';

import { flags as allFlags } from '../constants.js';
import { ApiError, ApiGateway } from '../gateways/api-gateway.js';
import {
  uploadBinary,
  uploadFlowZip,
  verifyAppZip,
  writeJSONFile,
} from '../methods.js';
import { DeviceValidationService } from '../services/device-validation.service.js';
import { plan } from '../services/execution-plan.service.js';
import {
  buildTestMetadataMap,
  computeCommonRoot,
} from '../services/flow-paths.js';
import { MoropoService } from '../services/moropo.service.js';
import { ReportDownloadService } from '../services/report-download.service.js';
import {
  ResultsPollingService,
  RunFailedError,
} from '../services/results-polling.service.js';
import { telemetry } from '../services/telemetry.service.js';
import { TestSubmissionService } from '../services/test-submission.service.js';
import { VersionService } from '../services/version.service.js';
import {
  EAndroidApiLevels,
  EAndroidDevices,
  EiOSDevices,
  EiOSVersions,
} from '../types/domain/device.types.js';
import { resolveAuth } from '../utils/auth.js';
import { isCI } from '../utils/ci.js';
import {
  CliError,
  coerceArray,
  getCliVersion,
  getUpgradeCommand,
  logger,
  parseIntFlag,
  validateEnum,
} from '../utils/cli.js';
import {
  CompatibilityData,
  fetchCompatibilityData,
} from '../utils/compatibility.js';
import { resolveApiUrl } from '../utils/config-store.js';
import { downloadExpoUrl, extractTarGz, findAppBundle, isUrl } from '../utils/expo.js';
import {
  colors,
  formatId,
  formatUrl,
  getConsoleUrl,
} from '../utils/styling.js';
import { type Field, ui } from '../utils/ui.js';

// Suppress punycode deprecation warning (caused by whatwg, supabase dependency).
// Every other warning must still reach the user — removeAllListeners drops
// Node's default printer, so re-emit manually.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (
    warning.name === 'DeprecationWarning' &&
    warning.message.includes('punycode')
  ) {
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(warning.stack ?? `${warning.name}: ${warning.message}`);
});

const DOWNLOAD_OPTIONS = ['ALL', 'FAILED'] as const;
const REPORT_OPTIONS = ['allure', 'html', 'html-detailed', 'junit'] as const;
const ORIENTATION_OPTIONS = ['0', '90'] as const;
const RUNNER_TYPE_OPTIONS = ['default', 'm4', 'm1', 'gpu1', 'cpu1'] as const;

/**
 * Primary CLI command for executing tests on DeviceCloud.
 * Orchestrates the complete test workflow:
 * - Binary upload with SHA deduplication
 * - Flow file analysis and dependency resolution
 * - Device compatibility validation
 * - Test submission with parallel execution
 * - Real-time result polling with 10-second intervals
 * - Artifact download (reports, videos, logs)
 *
 * Replaces `maestro cloud` with DeviceCloud-specific functionality.
 */
export const cloudCommand = defineCommand({
  meta: {
    name: 'cloud',
    description:
      'Test a Flow or set of Flows on devicecloud.dev (https://devicecloud.dev). Provide your application file and a folder with Maestro flows to run them in parallel on multiple devices. The command will block until all analyses have completed.',
  },
  args: {
    ...allFlags,
    firstFile: {
      type: 'positional',
      required: false,
      description:
        'The binary file of the app to run your flow against, e.g. test.apk for android or test.app/.zip for ios',
    },
    secondFile: {
      type: 'positional',
      required: false,
      description: 'The flow file to run against the app, e.g. test.yaml',
    },
  },
  // eslint-disable-next-line complexity
  async run({ args }) {
    const cliVersion = getCliVersion();
    const deviceValidationService = new DeviceValidationService();
    const moropoService = new MoropoService();
    const reportDownloadService = new ReportDownloadService();
    const resultsPollingService = new ResultsPollingService();
    const testSubmissionService = new TestSubmissionService();
    const versionService = new VersionService();

    const versionCheck = async () => {
      const latestVersion = await versionService.checkLatestCliVersion();
      if (latestVersion && versionService.isOutdated(cliVersion, latestVersion)) {
        out(ui.warn(colors.bold('Update available')));
        out(
          ui.branch([
            `A new version of the DeviceCloud CLI is available: ${colors.highlight(latestVersion)}`,
            `${colors.dim('Run:')} ${colors.info(getUpgradeCommand())}`,
          ]),
        );
      }
    };

    let output: unknown = null;
    let debugFlag = false;
    let jsonFile = false;
    let caughtError: unknown = null;
    const tempFiles: string[] = [];
    // json is captured early so the progress-suppressor works if we fail before destructuring.
    const jsonFlag = Boolean(args.json);
    // Chatty progress logs are suppressed when --json is active so stdout stays parseable.
    const out = (m: string) => {
      if (!jsonFlag) logger.log(m);
    };
    const warnOut = (m: string) => {
      if (!jsonFlag) logger.warn(m);
    };
    try {
      const apiKeyFlag = args['api-key'] as string | undefined;
      const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
      const appBinaryId = args['app-binary-id'] as string | undefined;
      const appFile = args['app-file'] as string | undefined;
      const appUrl = args['app-url'] as string | undefined;
      const artifactsPath = args['artifacts-path'] as string | undefined;
      const junitPath = args['junit-path'] as string | undefined;
      const allurePath = args['allure-path'] as string | undefined;
      const htmlPath = args['html-path'] as string | undefined;
      const async = Boolean(args.async);
      const configFile = args.config as string | undefined;
      const debug = Boolean(args.debug);
      const deviceLocale = args['device-locale'] as string | undefined;
      const downloadArtifacts = validateEnum(
        args['download-artifacts'] as string | undefined,
        DOWNLOAD_OPTIONS,
        'download-artifacts',
      );
      const dryRun = Boolean(args['dry-run']);
      const env = coerceArray(args.env as string | string[] | undefined, false);
      const excludeFlows = coerceArray(
        args['exclude-flows'] as string | string[] | undefined,
      );
      const excludeTags = coerceArray(
        args['exclude-tags'] as string | string[] | undefined,
      );
      let flows = args.flows as string | undefined;
      const googlePlay = Boolean(args['google-play']);
      const ignoreShaCheck = Boolean(args['ignore-sha-check']);
      const includeTags = coerceArray(
        args['include-tags'] as string | string[] | undefined,
      );
      const iOSDevice = validateEnum(
        args['ios-device'] as string | undefined,
        Object.values(EiOSDevices),
        'ios-device',
      );
      const iOSVersion = validateEnum(
        args['ios-version'] as string | undefined,
        Object.values(EiOSVersions),
        'ios-version',
      );
      const androidApiLevel = validateEnum(
        args['android-api-level'] as string | undefined,
        Object.values(EAndroidApiLevels),
        'android-api-level',
      );
      const androidDevice = validateEnum(
        args['android-device'] as string | undefined,
        Object.values(EAndroidDevices),
        'android-device',
      );
      const androidNoSnapshot = Boolean(args['android-no-snapshot']);
      const json = Boolean(args.json);
      const jsonFileFlag = Boolean(args['json-file']);
      const jsonFileName = args['json-file-name'] as string | undefined;
      const maestroVersion = args['maestro-version'] as string | undefined;
      const metadata = coerceArray(
        args.metadata as string | string[] | undefined,
        false,
      );
      const mitmHost = args.mitmHost as string | undefined;
      const mitmPath = args.mitmPath as string | undefined;
      const moropoApiKey = args['moropo-v1-api-key'] as string | undefined;
      const name = args.name as string | undefined;
      const orientation = validateEnum(
        args.orientation as string | undefined,
        ORIENTATION_OPTIONS,
        'orientation',
      );
      let quiet = Boolean(args.quiet);
      const report = validateEnum(
        args.report as string | undefined,
        REPORT_OPTIONS,
        'report',
      );
      let retry = parseIntFlag(args.retry as string | undefined, 'retry');
      const runnerType =
        validateEnum(
          args['runner-type'] as string | undefined,
          RUNNER_TYPE_OPTIONS,
          'runner-type',
        ) ?? 'default';
      const showCrosshairs = Boolean(args['show-crosshairs']);
      const maestroChromeOnboarding = Boolean(args['maestro-chrome-onboarding']);
      const disableAnimations = Boolean(args['disable-animations']);
      const ghBranch = args.branch as string | undefined;
      const ghCommitSha = args['commit-sha'] as string | undefined;
      const ghRepoName = args['repo-name'] as string | undefined;
      const ghPrNumber = args['pr-number'] as string | undefined;
      const ghPrUrl = args['pr-url'] as string | undefined;

      debugFlag = debug;
      jsonFile = jsonFileFlag;

      out(colors.dim(`dcd v${cliVersion}`));

      if (debug) {
        out('[DEBUG] Starting command execution with debug logging enabled');
        out(`[DEBUG] Node version: ${process.versions.node}`);
        out(`[DEBUG] OS: ${process.platform} ${process.arch}`);
      }

      if (jsonFileFlag) {
        quiet = true;
        out(
          '--json-file is true: JSON output will be written to file, forcing --quiet flag for better CI output',
        );
      }

      if (mitmPath && !mitmHost) {
        throw new CliError('--mitmPath requires --mitmHost to be set');
      }

      if (jsonFileName && !jsonFileFlag) {
        throw new CliError('--json-file-name requires --json-file');
      }

      if (artifactsPath && !downloadArtifacts) {
        throw new CliError('--artifacts-path requires --download-artifacts');
      }

      if ((junitPath || allurePath || htmlPath) && !report) {
        throw new CliError('Report path flags (--junit-path/--allure-path/--html-path) require --report');
      }

      if (appFile && appUrl) {
        throw new CliError('--app-file and --app-url are mutually exclusive');
      }

      if (json) {
        const originalStdoutWrite = process.stdout.write;
        process.stdout.write = function (
          chunk: Uint8Array | string,
          encodingOrCallback?: ((err?: Error | null) => void) | BufferEncoding,
          cb?: (err?: Error | null) => void,
        ) {
          if (
            typeof chunk === 'string' &&
            chunk.includes('Not sure what to do with typed value of type 0x4')
          ) {
            return true;
          }

          return originalStdoutWrite.call(
            process.stdout,
            chunk,
            encodingOrCallback as BufferEncoding | undefined,
            cb,
          );
        };
      }

      const [major] = process.versions.node.split('.').map(Number);
      if (major < 20) {
        warnOut(
          `WARNING: You are using node version ${major}. DeviceCloud requires node version 20 or later`,
        );
        if (major < 18) {
          throw new CliError('Invalid node version');
        }
      }

      await versionCheck();

      if (moropoApiKey) {
        flows = await moropoService.downloadAndExtract({
          apiKey: moropoApiKey,
          branchName: 'main',
          debug,
          json,
          logger: (m: string) => out(m),
          quiet,
        });
        tempFiles.push(flows);
      }

      const auth = await resolveAuth({ apiKeyFlag });

      // Nudge interactive api-key users toward `dcd login`, which unlocks live
      // (realtime) status updates. Suppressed in CI and non-interactive output.
      if (auth.mode === 'apiKey' && !json && !quiet && !isCI()) {
        out(
          colors.dim(
            'Tip: run `dcd login` for live test updates and a smoother experience than passing --api-key.',
          ),
        );
      }

      let compatibilityData: CompatibilityData;
      try {
        compatibilityData = await fetchCompatibilityData(apiUrl, auth);
        if (debug) {
          out('[DEBUG] Successfully fetched compatibility data from API');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (debug) {
          out(
            `[DEBUG] Failed to fetch compatibility data from API: ${errorMessage}`,
          );
        }

        throw new CliError(
          `Failed to fetch device compatibility data: ${errorMessage}. Please check your API key and connection.`,
        );
      }

      if (debug) {
        out(`[DEBUG] API URL: ${apiUrl}`);
      }

      const resolvedMaestroVersion = versionService.resolveMaestroVersion(
        maestroVersion,
        compatibilityData,
        {
          debug,
          logger: (m: string) => out(m),
        },
      );

      const REMOVED_MAESTRO_VERSIONS = ['1.39.1', '1.39.2', '1.39.7', '2.0.3', '2.4.0'];
      if (REMOVED_MAESTRO_VERSIONS.includes(resolvedMaestroVersion)) {
        throw new CliError(
          `Maestro version ${resolvedMaestroVersion} is no longer supported. ` +
            `Please upgrade to a newer version. See: https://docs.devicecloud.dev/configuration/maestro-versions`,
        );
      }

      if (retry !== undefined && retry > 2) {
        out(
          ui.warn(
            'Retries are now free of charge but limited to 2. If your test is still failing after 2 retries, please ask for help on Discord.',
          ),
        );
        retry = 2;
      }

      if (runnerType === 'm4') {
        out(
          ui.info(
            'runnerType m4 is experimental and currently supports iOS only, Android will revert to default.',
          ),
        );
      }

      if (runnerType === 'm1') {
        out(
          ui.info(
            'runnerType m1 is experimental and currently supports Android (Pixel 7, API Level 34) only.',
          ),
        );
      }

      if (runnerType === 'gpu1') {
        out(
          ui.info(
            'runnerType gpu1 is Android-only (all devices, API Level 34 or 35), available to all users.',
          ),
        );
      }

      const firstFile = args.firstFile as string | undefined;
      const secondFile = args.secondFile as string | undefined;
      let finalBinaryId = appBinaryId;
      let finalAppFile: string | undefined = appFile ?? (appUrl ?? firstFile);
      let flowFile = flows ?? secondFile;

      if (finalAppFile && !appBinaryId) {
        if (isUrl(finalAppFile)) {
          out(`   ${colors.dim('→ Downloading Expo build from URL...')}`);
          const tarPath = await downloadExpoUrl(finalAppFile, debug);
          tempFiles.push(tarPath);
          finalAppFile = tarPath;
        }

        if (finalAppFile.endsWith('.tar.gz')) {
          out(`   ${colors.dim('→ Extracting Expo archive...')}`);
          const extractDir = await extractTarGz(finalAppFile, debug);
          tempFiles.push(extractDir);
          finalAppFile = await findAppBundle(extractDir);
          if (debug) {
            out(`[DEBUG] Found .app bundle at: ${finalAppFile}`);
          }
        }
      }

      if (debug) {
        out(`[DEBUG] First file argument: ${firstFile || 'not provided'}`);
        out(`[DEBUG] Second file argument: ${secondFile || 'not provided'}`);
        out(`[DEBUG] App binary ID: ${appBinaryId || 'not provided'}`);
        out(`[DEBUG] App file: ${finalAppFile || 'not provided'}`);
        out(`[DEBUG] Flow file: ${flowFile || 'not provided'}`);
      }

      if (appBinaryId) {
        if (secondFile) {
          throw new CliError('You cannot provide both an appBinaryId and a binary file');
        }
        flowFile = flows ?? firstFile;
      } else if ((appFile || appUrl) && !flowFile) {
        // The app came from a flag, so the first positional (if any) is the
        // flow file — previously it was silently dropped.
        flowFile = firstFile;
      }

      if (!flowFile) {
        throw new CliError('You must provide a flow file');
      }

      deviceValidationService.validateiOSDevice(iOSVersion, iOSDevice, compatibilityData, {
        debug,
        logger: (m: string) => out(m),
      });

      // iOS 16 deprecation notice (soft warning during the grace period;
      // removed on 23 August 2026). Only fires on an explicit --ios-version 16 —
      // when omitted the API defaults to iOS 17, so no false warning.
      const DEPRECATED_IOS_VERSIONS = ['16'];
      if (iOSVersion && DEPRECATED_IOS_VERSIONS.includes(iOSVersion)) {
        warnOut(ui.warn(colors.bold('iOS 16 is deprecated')));
        warnOut(
          ui.branch([
            'iOS 16 will be removed on 23 August 2026; after that, tests targeting it will fail.',
            'Switch to iOS 17 or newer — iPhone 14 also supports 17 and 18.',
            `${colors.dim('See:')} ${colors.url('https://docs.devicecloud.dev/getting-started/devices-configuration')}`,
          ]),
        );
      }

      deviceValidationService.validateAndroidDevice(
        androidApiLevel,
        androidDevice,
        googlePlay,
        compatibilityData,
        { debug, logger: (m: string) => out(m) },
      );

      if (maestroChromeOnboarding && !androidApiLevel && !androidDevice) {
        warnOut(
          'The --maestro-chrome-onboarding flag only applies to Android tests and will be ignored for iOS tests.',
        );
      }

      flowFile = path.resolve(flowFile);

      if (
        !flowFile?.endsWith('.yaml') &&
        !flowFile?.endsWith('.yml') &&
        !flowFile?.endsWith('/')
      ) {
        flowFile += '/';
      }

      if (debug) {
        out(`[DEBUG] Resolved flow file path: ${flowFile}`);
      }

      let executionPlan;
      try {
        if (debug) {
          out('[DEBUG] Generating execution plan...');
        }

        executionPlan = await plan({
          input: flowFile,
          includeTags,
          excludeTags,
          excludeFlows,
          configFile,
          debug,
        });

        if (debug) {
          out(`[DEBUG] Execution plan generated`);
          out(`[DEBUG] Total flow files: ${executionPlan.totalFlowFiles}`);
          out(`[DEBUG] Flows to run: ${executionPlan.flowsToRun.length}`);
          out(
            `[DEBUG] Referenced files: ${executionPlan.referencedFiles.length}`,
          );
          out(
            `[DEBUG] Sequential flows: ${executionPlan.sequence?.flows.length || 0}`,
          );
        }
      } catch (error) {
        if (debug) {
          out(`[DEBUG] Error generating execution plan: ${error}`);
        }

        throw error;
      }

      const {
        allExcludeTags,
        allIncludeTags,
        flowMetadata,
        flowOverrides,
        flowsToRun: testFileNames,
        referencedFiles,
        sequence,
      } = executionPlan;

      if (debug) {
        out(
          `[DEBUG] All include tags: ${allIncludeTags?.join(', ') || 'none'}`,
        );
        out(
          `[DEBUG] All exclude tags: ${allExcludeTags?.join(', ') || 'none'}`,
        );
        out(`[DEBUG] Test file names: ${testFileNames.join(', ')}`);
      }

      const commonRoot = computeCommonRoot(testFileNames, referencedFiles);

      if (debug) {
        out(`[DEBUG] Common root directory: ${commonRoot}`);
      }

      const testMetadataMap = buildTestMetadataMap(flowMetadata, commonRoot);

      if (debug) {
        out(
          `[DEBUG] Built testMetadataMap for ${Object.keys(testMetadataMap).length} flows`,
        );
      }

      const { continueOnFailure = true, flows: sequentialFlows = [] } = sequence ?? {};

      if (debug && sequentialFlows.length > 0) {
        out(`[DEBUG] Sequential flows: ${sequentialFlows.join(', ')}`);
        out(`[DEBUG] Continue on failure: ${continueOnFailure}`);
      }

      if (!appBinaryId) {
        if (!(flowFile && finalAppFile)) {
          throw new CliError('You must provide a flow file and an app binary id');
        }

        if (
          !['.apk', '.app', '.zip', '.tar.gz'].some((ext) =>
            (finalAppFile as string).endsWith(ext),
          )
        ) {
          throw new CliError(
            'App file must be a .apk for Android, .app/.zip for iOS, or .tar.gz (Expo iOS build)',
          );
        }

        if (finalAppFile.endsWith('.zip')) {
          if (debug) {
            out(`[DEBUG] Verifying iOS app zip file: ${finalAppFile}`);
          }
          await verifyAppZip(finalAppFile);
        }
      }

      const flagLogs: string[] = [];
      // app-url carries a signed (bearer-style) download URL — treat as secret.
      const sensitiveFlags = new Set([
        'api-key',
        'apiKey',
        'moropo-v1-api-key',
        'app-url',
        'appUrl',
      ]);
      // Only log canonical flag keys (skip citty-populated alias duplicates like apiURL/apiUrl).
      const canonicalFlagKeys = new Set(Object.keys(allFlags));
      for (const [k, v] of Object.entries(args)) {
        if (!canonicalFlagKeys.has(k)) continue;
        if (v === undefined || v === null || v === false) continue;
        const asString = String(v);
        if (asString.length > 0 && !sensitiveFlags.has(k)) {
          flagLogs.push(`${k}: ${asString}`);
        }
      }

      const overridesEntries = Object.entries(flowOverrides);
      const hasOverrides = overridesEntries.some(
        ([, overrides]) => Object.keys(overrides).length > 0,
      );

      const submitRows: string[] = ui.fields([
        ['flow(s)', colors.highlight(flowFile)],
        ['app', colors.highlight(appBinaryId || finalAppFile || '')],
      ]);

      if (flagLogs.length > 0) {
        submitRows.push('', colors.bold('Options'));
        submitRows.push(
          ...ui.fields(
            flagLogs.map((flagLog) => {
              const [key, ...valueParts] = flagLog.split(': ');
              return [key, colors.highlight(valueParts.join(': '))] as Field;
            }),
          ),
        );
      }

      if (hasOverrides) {
        submitRows.push('', colors.bold('Overrides'));
        for (const [flowPath, overrides] of overridesEntries) {
          if (Object.keys(overrides).length === 0) {
            continue;
          }
          submitRows.push(colors.dim(`${flowPath.replace(process.cwd(), '.')}:`));
          submitRows.push(
            ...ui.fields(
              Object.entries(overrides).map(
                ([key, value]) => [key, colors.highlight(String(value))] as Field,
              ),
            ),
          );
        }
      }

      out(ui.section('Submitting new job'));
      out(ui.branch(submitRows));

      if (dryRun) {
        out(
          ui.warn(
            `${colors.bold('Dry run mode')} ${colors.dim('— no tests were actually triggered')}`,
          ),
        );
        out(ui.section('The following tests would have been run'));
        out(ui.branch(testFileNames));

        if (sequentialFlows.length > 0) {
          out(ui.section('Sequential flows'));
          out(ui.branch(sequentialFlows));
        }

        return;
      }

      if (!finalBinaryId) {
        if (!finalAppFile) {
          throw new CliError(
            'You must provide either an app binary id or an app file',
          );
        }

        if (debug) {
          out(`[DEBUG] Uploading binary file: ${finalAppFile}`);
        }

        const binaryId = await uploadBinary({
          auth,
          apiUrl,
          debug,
          filePath: finalAppFile,
          ignoreShaCheck,
          log: !json,
        });
        finalBinaryId = binaryId;

        if (debug) {
          out(`[DEBUG] Binary uploaded with ID: ${binaryId}`);
        }
      }

      if (!finalBinaryId) {
        throw new CliError(
          'Internal error: finalBinaryId should be defined after validation',
        );
      }

      const ghMetadataOverrides: string[] = [];
      if (ghBranch) ghMetadataOverrides.push(`gh_branch=${ghBranch}`);
      if (ghCommitSha) ghMetadataOverrides.push(`gh_sha=${ghCommitSha}`);
      if (ghRepoName) ghMetadataOverrides.push(`gh_repo=${ghRepoName}`);
      if (ghPrNumber) ghMetadataOverrides.push(`gh_pr_number=${ghPrNumber}`);
      if (ghPrUrl) ghMetadataOverrides.push(`gh_pr_url=${ghPrUrl}`);
      const mergedMetadata = [...ghMetadataOverrides, ...metadata];

      const { buffer, fields } = await testSubmissionService.buildTestPayload({
        androidApiLevel,
        androidDevice,
        androidNoSnapshot,
        appBinaryId: finalBinaryId,
        cliVersion,
        commonRoot,
        continueOnFailure,
        debug,
        deviceLocale,
        env,
        executionPlan,
        flowFile,
        googlePlay,
        iOSDevice,
        iOSVersion,
        logger: (m: string) => out(m),
        maestroVersion: resolvedMaestroVersion,
        metadata: mergedMetadata,
        mitmHost,
        mitmPath,
        name,
        orientation,
        raw: [],
        report,
        retry,
        runnerType,
        showCrosshairs,
        maestroChromeOnboarding,
        disableAnimations,
      });

      // New path: upload the zip directly to storage, then submit a JSON test
      // referencing it. Older API deployments lack these endpoints — a real API
      // 404s (route undefined), some proxies 405 (path/method not allowed); in
      // either case fall back to the legacy multipart POST /uploads/flow, which
      // is byte-identical bar the storage reference.
      let response: Awaited<ReturnType<typeof ApiGateway.submitFlowTest>>;
      try {
        const storageRef = await uploadFlowZip({ apiUrl, auth, buffer, debug });

        if (debug) {
          out(
            `[DEBUG] Flow zip uploaded (id=${storageRef.id}, supabase=${storageRef.supabaseSuccess}, backblaze=${storageRef.backblazeSuccess})`,
          );
          out(`[DEBUG] Submitting flow test to ${apiUrl}/uploads/submitFlowTest`);
        }

        response = await ApiGateway.submitFlowTest(apiUrl, auth, {
          ...fields,
          ...storageRef,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 404 || error.status === 405)
        ) {
          if (debug) {
            out(
              `[DEBUG] Client-direct flow upload unavailable (HTTP ${error.status}); falling back to multipart ${apiUrl}/uploads/flow`,
            );
          }

          const testFormData = testSubmissionService.buildFormData(fields, buffer);
          response = await ApiGateway.uploadFlow(apiUrl, auth, testFormData);
        } else {
          throw error;
        }
      }

      const { message, results } = response;

      if (debug) {
        out(`[DEBUG] Flow submission response received`);
        out(`[DEBUG] Message: ${message}`);
        out(`[DEBUG] Results count: ${results?.length || 0}`);
      }

      if (!results?.length) {
        throw new CliError('No tests created: ' + message);
      }
      out(`${ui.success('Submitted')} ${colors.dim(message)}`);

      const testNames = results
        .map((r) => r.test_file_name)
        .sort((a, b) => a.localeCompare(b))
        .join(colors.dim(', '));
      const url = getConsoleUrl(apiUrl, results[0].test_upload_id, results[0].id);

      out(ui.section(`Created ${results.length} test${results.length === 1 ? '' : 's'}`));
      out(
        ui.branch([
          testNames,
          ...ui.fields([
            ['results', formatUrl(url)],
            ['upload id', formatId(results[0].test_upload_id)],
            [
              'poll status',
              colors.info(`dcd status --upload-id ${results[0].test_upload_id}`),
            ],
          ]),
        ]),
      );

      if (async) {
        if (debug) {
          out(`[DEBUG] Async flag is set, not waiting for results`);
        }

        const jsonOutput = {
          consoleUrl: url,
          status: 'PENDING',
          tests: results.map((r) => ({
            fileName: r.test_file_name,
            flowName:
              testMetadataMap[r.test_file_name]?.flowName ||
              path.parse(r.test_file_name).name,
            name: r.test_file_name,
            status: r.status,
            tags: testMetadataMap[r.test_file_name]?.tags || [],
          })),
          uploadId: results[0].test_upload_id,
        };

        if (jsonFileFlag) {
          const jsonFilePath = jsonFileName || `${results[0].test_upload_id}_dcd.json`;
          writeJSONFile(jsonFilePath, jsonOutput, {
            log: (m: string) => out(m),
            warn: (m: string) => warnOut(m),
          });
        }

        if (json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(jsonOutput, null, 2));
          return;
        }

        out(ui.info('Not waiting for results as async flag is set to true'));
        return;
      }

      const pollingResult = await resultsPollingService
        .pollUntilComplete(
          {
            auth,
            apiUrl,
            consoleUrl: url,
            debug,
            json,
            logger: (m: string) => out(m),
            quiet,
            uploadId: results[0].test_upload_id as string,
          },
          testMetadataMap,
        )
        .catch(async (error: Error) => {
          if (error instanceof RunFailedError) {
            const jsonOutput = error.result;
            if (jsonFileFlag) {
              const jsonFilePath =
                jsonFileName || `${results[0].test_upload_id}_dcd.json`;
              writeJSONFile(jsonFilePath, jsonOutput, {
                log: (m: string) => out(m),
                warn: (m: string) => warnOut(m),
              });
            }

            if (json) {
              output = jsonOutput;
            }

            // A download failure must not mask the run-failed signal (it
            // would flip exit code 2 → 1 and drop the JSON output).
            try {
              if (downloadArtifacts) {
                await reportDownloadService.downloadArtifacts({
                  auth,
                  apiUrl,
                  artifactsPath,
                  debug,
                  downloadType: downloadArtifacts,
                  logger: (m: string) => out(m),
                  uploadId: results[0].test_upload_id as string,
                  warnLogger: (m: string) => warnOut(m),
                });
              }

              if (report) {
                await reportDownloadService.downloadReports({
                  allurePath,
                  auth,
                  apiUrl,
                  debug,
                  htmlPath,
                  junitPath,
                  logger: (m: string) => out(m),
                  reportType: report,
                  uploadId: results[0].test_upload_id as string,
                  warnLogger: (m: string) => warnOut(m),
                });
              }
            } catch (downloadError) {
              warnOut(
                `Failed to download artifacts/reports for the failed run: ${
                  downloadError instanceof Error
                    ? downloadError.message
                    : String(downloadError)
                }`,
              );
            }

            throw new Error('RUN_FAILED');
          }

          throw error;
        });

      if (downloadArtifacts) {
        await reportDownloadService.downloadArtifacts({
          auth,
          apiUrl,
          artifactsPath,
          debug,
          downloadType: downloadArtifacts,
          logger: (m: string) => out(m),
          uploadId: results[0].test_upload_id as string,
          warnLogger: (m: string) => warnOut(m),
        });
      }

      if (report) {
        await reportDownloadService.downloadReports({
          allurePath,
          auth,
          apiUrl,
          debug,
          htmlPath,
          junitPath,
          logger: (m: string) => out(m),
          reportType: report,
          uploadId: results[0].test_upload_id as string,
          warnLogger: (m: string) => warnOut(m),
        });
      }

      const jsonOutput = pollingResult;
      if (jsonFileFlag) {
        const jsonFilePath = jsonFileName || `${results[0].test_upload_id}_dcd.json`;
        writeJSONFile(jsonFilePath, jsonOutput, {
          log: (m: string) => out(m),
          warn: (m: string) => warnOut(m),
        });
      }

      if (json) {
        output = jsonOutput;
      }
    } catch (error) {
      if (debugFlag && error instanceof Error) {
        out(`[DEBUG] Error in command execution: ${error.message}`);
        out(`[DEBUG] Error stack: ${error.stack}`);
      }

      // Defer exiting until after the finally block — process.exit here would
      // skip it, dropping the --json output and leaking temp files.
      caughtError = error;
    } finally {
      const fsp = await import('node:fs/promises');
      for (const p of tempFiles) {
        await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
      }

      if (output) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(output, null, 2));
      }
    }

    if (caughtError) {
      if (caughtError instanceof Error && caughtError.message === 'RUN_FAILED') {
        // --json-file keeps exit 0 on a failed run (documented contract);
        // otherwise 2 distinguishes test failure from infra errors (1).
        const exitCode = jsonFile ? 0 : 2;
        telemetry.recordCommandFailure({ error: 'RUN_FAILED', exitCode });
        telemetry.flushSync();
        process.exit(exitCode);
      }

      logger.error(caughtError as Error, { exit: 1, json: jsonFlag });
    }
  },
});

export default cloudCommand;
