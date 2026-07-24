import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ApiError, ApiGateway } from '../../gateways/api-gateway.js';
import { plan } from '../../services/execution-plan.service.js';
import { computeCommonRoot, buildTestMetadataMap } from '../../services/flow-paths.js';
import { DeviceValidationService } from '../../services/device-validation.service.js';
import { TestSubmissionService } from '../../services/test-submission.service.js';
import { VersionService } from '../../services/version.service.js';
import { uploadBinary, uploadFlowZip, verifyAppZip } from '../../methods.js';
import { getCliVersion } from '../../utils/cli.js';
import { fetchCompatibilityData } from '../../utils/compatibility.js';
import { isEncryptionEnabled } from '../../utils/envelope.js';
import { getConsoleUrl } from '../../utils/styling.js';
import { getContext, logStderr } from '../context.js';
import { jsonResult, runTool } from '../helpers.js';

const SUPPORTED_APP_EXTENSIONS = ['.apk', '.app', '.zip'];
const POLL_INTERVAL_MS = 10_000;
const TERMINAL_STATUSES = new Set(['PASSED', 'FAILED', 'CANCELLED', 'ERROR']);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Submit a Maestro flow (or directory of flows) to devicecloud.dev.
 *
 * This is the only state-changing / billable tool — it consumes test minutes,
 * so it is hidden in read-only mode and annotated as non-read-only/destructive
 * so clients can gate it behind confirmation. Defaults to async (submit and
 * return the upload id); set `wait: true` to block until completion, bounded by
 * `waitTimeoutSeconds`.
 *
 * Mirrors the `dcd cloud` command's submission path but headless: no Expo URL
 * download, mitm, GitHub metadata, or JSON-file output. Use the CLI for those.
 */
export function registerRunCloudTest(server: McpServer): void {
  server.registerTool(
    'dcd_run_cloud_test',
    {
      title: 'Run a cloud test',
      description:
        'Submit a Maestro flow (or a directory of flows) to run on devicecloud.dev. ' +
        'Consumes test minutes (billable). Provide a flowFile plus either appFile (a local .apk/.app/.zip) or appBinaryId (a previously uploaded binary). ' +
        'Defaults to async: returns { uploadId, consoleUrl, status: "PENDING", tests } immediately — poll dcd_get_status with the uploadId. ' +
        'Set wait: true to block until the run finishes (bounded by waitTimeoutSeconds). ' +
        'Set dryRun: true to preview which flows would run without submitting.',
      inputSchema: {
        flowFile: z
          .string()
          .describe('Path to a Maestro flow .yaml/.yml file, or a directory of flows'),
        appFile: z
          .string()
          .optional()
          .describe('Path to a local app binary (.apk, .app, or .zip). Mutually exclusive with appBinaryId.'),
        appBinaryId: z
          .string()
          .optional()
          .describe('ID of a previously uploaded binary. Mutually exclusive with appFile.'),
        iosVersion: z.string().optional().describe('iOS version, e.g. "17"'),
        iosDevice: z.string().optional().describe('iOS device, e.g. "iphone-14"'),
        androidApiLevel: z.string().optional().describe('Android API level, e.g. "34"'),
        androidDevice: z.string().optional().describe('Android device, e.g. "pixel-7"'),
        googlePlay: z.boolean().optional().describe('Use a Google Play-enabled Android image'),
        name: z.string().optional().describe('A name for this run'),
        env: z
          .array(z.string())
          .optional()
          .describe('Environment variables as KEY=VALUE strings'),
        includeTags: z.array(z.string()).optional().describe('Only run flows with these tags'),
        excludeTags: z.array(z.string()).optional().describe('Skip flows with these tags'),
        excludeFlows: z.array(z.string()).optional().describe('Flow paths/patterns to exclude'),
        maestroVersion: z.string().optional().describe('Pin a specific Maestro version'),
        retry: z.number().int().min(0).max(2).optional().describe('Auto-retry failed tests (max 2)'),
        runnerType: z
          .enum(['default', 'm4', 'm1', 'gpu1', 'cpu1'])
          .optional()
          .describe('Runner type (default "default")'),
        configFile: z.string().optional().describe('Path to a workspace config.yaml'),
        ignoreShaCheck: z
          .boolean()
          .optional()
          .describe('Force re-upload of the binary even if an identical one exists'),
        dryRun: z.boolean().optional().describe('Preview flows that would run without submitting'),
        wait: z
          .boolean()
          .optional()
          .describe('Block until the run completes instead of returning immediately (default false)'),
        waitTimeoutSeconds: z
          .number()
          .int()
          .min(30)
          .max(3600)
          .optional()
          .describe('Max seconds to wait when wait is true (default 600)'),
      },
      annotations: {
        title: 'Run a cloud test',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool('dcd_run_cloud_test', async () => {
        if (args.appFile && args.appBinaryId) {
          throw new Error('Provide only one of appFile or appBinaryId, not both.');
        }

        const { apiUrl, auth } = await getContext();
        const cliVersion = getCliVersion();
        const compatibilityData = await fetchCompatibilityData(apiUrl, auth);

        const deviceValidation = new DeviceValidationService();
        deviceValidation.validateiOSDevice(
          args.iosVersion,
          args.iosDevice,
          compatibilityData,
          { logger: logStderr },
        );
        deviceValidation.validateAndroidDevice(
          args.androidApiLevel,
          args.androidDevice,
          Boolean(args.googlePlay),
          compatibilityData,
          { logger: logStderr },
        );

        const resolvedMaestroVersion = new VersionService().resolveMaestroVersion(
          args.maestroVersion,
          compatibilityData,
          { logger: logStderr },
        );

        // Directory inputs must end in a separator so the planner treats them
        // as a workspace rather than a single file.
        let flowFile = path.resolve(args.flowFile);
        if (
          !flowFile.endsWith('.yaml') &&
          !flowFile.endsWith('.yml') &&
          !flowFile.endsWith('/')
        ) {
          flowFile += '/';
        }

        const executionPlan = await plan({
          input: flowFile,
          includeTags: args.includeTags ?? [],
          excludeTags: args.excludeTags ?? [],
          excludeFlows: args.excludeFlows,
          configFile: args.configFile,
        });

        const commonRoot = computeCommonRoot(
          executionPlan.flowsToRun,
          executionPlan.referencedFiles,
        );
        const testMetadataMap = buildTestMetadataMap(
          executionPlan.flowMetadata,
          commonRoot,
        );

        if (args.dryRun) {
          return jsonResult({
            dryRun: true,
            flows: Object.entries(testMetadataMap).map(([file, meta]) => ({
              file,
              flowName: meta.flowName,
              tags: meta.tags,
            })),
            sequentialFlowCount: executionPlan.sequence?.flows.length ?? 0,
          });
        }

        // Client-side envelope encryption (binary/flow/env). No MCP flag, so
        // it's env-driven: DCD_ENCRYPT / DCD_ENCRYPT_BINARIES.
        const encrypt = isEncryptionEnabled();

        // Resolve the binary: existing id, or upload the local file.
        let appBinaryId = args.appBinaryId;
        if (!appBinaryId) {
          if (!args.appFile) {
            throw new Error('Provide either appFile or appBinaryId.');
          }
          if (!SUPPORTED_APP_EXTENSIONS.some((ext) => args.appFile!.endsWith(ext))) {
            throw new Error(
              `App file must be one of: ${SUPPORTED_APP_EXTENSIONS.join(', ')} (got ${args.appFile}).`,
            );
          }
          if (args.appFile.endsWith('.zip')) {
            await verifyAppZip(args.appFile);
          }
          appBinaryId = await uploadBinary({
            auth,
            apiUrl,
            encrypt,
            filePath: args.appFile,
            ignoreShaCheck: Boolean(args.ignoreShaCheck),
            log: false,
          });
        }

        const { continueOnFailure = true } = executionPlan.sequence ?? {};
        const testSubmissionService = new TestSubmissionService();
        const { buffer, fields } = await testSubmissionService.buildTestPayload({
          apiUrl,
          appBinaryId,
          cliVersion,
          commonRoot,
          continueOnFailure,
          encrypt,
          executionPlan,
          flowFile,
          env: args.env ?? [],
          googlePlay: Boolean(args.googlePlay),
          androidApiLevel: args.androidApiLevel,
          androidDevice: args.androidDevice,
          iOSDevice: args.iosDevice,
          iOSVersion: args.iosVersion,
          name: args.name,
          runnerType: args.runnerType ?? 'default',
          maestroVersion: resolvedMaestroVersion,
          retry: args.retry,
          logger: logStderr,
        });

        // New path: upload the zip to storage, then submit a JSON test
        // referencing it. Older API deployments lack these endpoints (404/405);
        // fall back to the legacy multipart POST /uploads/flow. Mirrors
        // `dcd cloud`.
        let response: Awaited<ReturnType<typeof ApiGateway.submitFlowTest>>;
        try {
          const storageRef = await uploadFlowZip({ apiUrl, auth, buffer });
          response = await ApiGateway.submitFlowTest(apiUrl, auth, {
            ...fields,
            ...storageRef,
          });
        } catch (error) {
          if (
            error instanceof ApiError &&
            (error.status === 404 || error.status === 405)
          ) {
            const testFormData = testSubmissionService.buildFormData(
              fields,
              buffer,
            );
            response = await ApiGateway.uploadFlow(apiUrl, auth, testFormData);
          } else {
            throw error;
          }
        }

        const { message, results } = response;
        if (!results?.length) {
          throw new Error(`No tests were created: ${message}`);
        }

        const uploadId = results[0].test_upload_id as string;
        const consoleUrl = getConsoleUrl(apiUrl, uploadId, results[0].id);
        const tests = results.map((r) => ({
          fileName: r.test_file_name,
          flowName:
            testMetadataMap[r.test_file_name]?.flowName ||
            path.parse(r.test_file_name).name,
          tags: testMetadataMap[r.test_file_name]?.tags ?? [],
          status: r.status,
        }));

        if (!args.wait) {
          return jsonResult({ uploadId, consoleUrl, status: 'PENDING', tests, message });
        }

        // Bounded poll. The run continues in the cloud regardless of timeout —
        // the caller can resume with dcd_get_status using the returned uploadId.
        const deadline =
          Date.now() + (args.waitTimeoutSeconds ?? 600) * 1000;
        for (;;) {
          const status = await ApiGateway.getUploadStatus(apiUrl, auth, { uploadId });
          if (TERMINAL_STATUSES.has(status.status)) {
            return jsonResult({ uploadId, consoleUrl, status: status.status, tests: status.tests });
          }
          if (Date.now() + POLL_INTERVAL_MS >= deadline) {
            return jsonResult({
              uploadId,
              consoleUrl,
              status: status.status,
              timedOut: true,
              tests: status.tests,
              message: `Still running after ${args.waitTimeoutSeconds ?? 600}s; poll dcd_get_status with uploadId ${uploadId}.`,
            });
          }
          await sleep(POLL_INTERVAL_MS);
        }
      }),
  );
}
