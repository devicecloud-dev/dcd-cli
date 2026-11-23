import { defineCommand } from 'citty';

import { apiFlags } from '../config/flags/api.flags.js';
import { jsonFlag } from '../config/flags/output.flags.js';
import {
  type DownloadResult,
  downloadsSucceeded,
  ReportDownloadService,
  reportFormatDeprecation,
} from '../services/report-download.service.js';
import { resolveAuth } from '../utils/auth.js';
import { CliError, logger, validateEnum } from '../utils/cli.js';
import { resolveApiUrl } from '../utils/config-store.js';
import { forStderr } from '../utils/styling.js';
import { ui } from '../utils/ui.js';

const DOWNLOAD_OPTIONS = ['ALL', 'FAILED'] as const;
const REPORT_OPTIONS = ['allure', 'html', 'html-detailed', 'junit'] as const;

export const artifactsCommand = defineCommand({
  meta: {
    name: 'artifacts',
    description: 'Download artifacts or reports for a completed test run',
  },
  args: {
    ...apiFlags,
    debug: {
      type: 'boolean',
      default: false,
      description: 'Enable detailed debug logging for troubleshooting issues',
    },
    'upload-id': {
      type: 'string',
      required: true,
      description: 'UUID of the completed upload to download artifacts for',
    },
    'download-artifacts': {
      type: 'string',
      description:
        'Download a zip containing the logs, screenshots and videos for this run (options: ALL, FAILED)',
    },
    'artifacts-path': {
      type: 'string',
      description:
        'Custom file path for downloaded artifacts (default: ./artifacts.zip). Requires --download-artifacts.',
    },
    'result-id': {
      type: 'string',
      description:
        "Download only this result's artifacts: its flow's attempts on that one device. Requires --download-artifacts.",
    },
    flow: {
      type: 'string',
      description:
        'Download only the artifacts of the flow with this file path or name (e.g. flows/login.yaml or login). Fails, listing the result ids, when it matches more than one result, e.g. one per device. Requires --download-artifacts.',
    },
    report: {
      type: 'string',
      description:
        'Download a test report in the specified format (options: junit, html, html-detailed, allure). allure and html-detailed are deprecated and will be removed on 7 December 2026.',
    },
    'allure-path': {
      type: 'string',
      description:
        'Custom file path for downloaded Allure report (default: ./report.html). Deprecated: Allure reports will be removed on 7 December 2026.',
    },
    'html-path': {
      type: 'string',
      description:
        'Custom file path for the downloaded HTML report, a ZIP of report.html and its assets (default: ./report.zip)',
    },
    'junit-path': {
      type: 'string',
      description:
        'Custom file path for downloaded JUnit report (default: ./report.xml)',
    },
    json: jsonFlag,
  },
  async run({ args }) {
    const apiKeyFlag = args['api-key'] as string | undefined;
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const debug = Boolean(args.debug);
    const uploadId = args['upload-id'] as string;
    const downloadArtifacts = validateEnum(
      args['download-artifacts'] as string | undefined,
      DOWNLOAD_OPTIONS,
      'download-artifacts',
    );
    const artifactsPath = args['artifacts-path'] as string | undefined;
    const resultIdArg = args['result-id'] as string | undefined;
    const flow = args.flow as string | undefined;
    const report = validateEnum(
      args.report as string | undefined,
      REPORT_OPTIONS,
      'report',
    );
    const allurePath = args['allure-path'] as string | undefined;
    const htmlPath = args['html-path'] as string | undefined;
    const junitPath = args['junit-path'] as string | undefined;
    const json = Boolean(args.json);
    // Success lines are dropped under --json; warnings stay on stderr.
    const log = json ? undefined : (m: string) => logger.log(m);

    // This command fetches no notices and submits nothing, so neither the
    // deprecation notice nor the API's submit warning reaches it.
    const deprecation = reportFormatDeprecation(report);
    if (deprecation) {
      process.stderr.write(`${forStderr(ui.deprecation(deprecation))}\n`);
    }

    const auth = await resolveAuth({ apiKeyFlag });

    if (downloadArtifacts && report) {
      throw new CliError(
        '--download-artifacts cannot also be provided when using --report (flags are mutually exclusive).',
      );
    }

    if (!downloadArtifacts && !report) {
      throw new CliError(
        'Either --download-artifacts or --report must be specified.',
      );
    }

    const resultId = parseResultFilter(resultIdArg, flow, Boolean(downloadArtifacts));

    const service = new ReportDownloadService();
    const downloads: DownloadResult[] = [];

    if (downloadArtifacts) {
      downloads.push(await service.downloadArtifacts({
        auth,
        apiUrl,
        artifactsPath: artifactsPath ?? './artifacts.zip',
        debug,
        downloadType: downloadArtifacts,
        flow,
        logger: log,
        resultId,
        uploadId,
        warnLogger: (m: string) => logger.warn(m),
      }));
    }

    if (report) {
      const result = await service.downloadReports({
        allurePath,
        auth,
        apiUrl,
        debug,
        htmlPath,
        junitPath,
        logger: log,
        reportType: report,
        uploadId,
        warnLogger: (m: string) => logger.warn(m),
      });
      if (result) downloads.push(result);
    }

    // Downloading is this command's only job, so a failed or incomplete
    // download exits 1, with or without --json. Its warning is already
    // printed, and fail() prints nothing more (no second JSON object).
    const ok = downloadsSucceeded(downloads);
    if (json) {
      logger.json({ status: ok ? 'SUCCESS' : 'FAILED', uploadId, downloads });
    }

    if (!ok) logger.fail('Download failed', 1);
  },
});

/**
 * Check --result-id and --flow: at most one, only with --download-artifacts,
 * and a result id that is a positive whole number. Returns the parsed id.
 */
export function parseResultFilter(
  resultIdArg: string | undefined,
  flow: string | undefined,
  downloadingArtifacts: boolean,
): number | undefined {
  if (resultIdArg !== undefined && flow !== undefined) {
    throw new CliError(
      '--result-id cannot also be provided when using --flow (flags are mutually exclusive).',
    );
  }

  const flag = resultIdArg === undefined ? (flow === undefined ? undefined : '--flow') : '--result-id';
  if (flag && !downloadingArtifacts) {
    throw new CliError(`${flag} requires --download-artifacts.`);
  }

  if (flow !== undefined && flow.trim() === '') {
    throw new CliError('--flow needs a flow file path or name.');
  }

  if (resultIdArg === undefined) return undefined;
  const resultId = Number(resultIdArg);
  if (!/^\d+$/.test(resultIdArg.trim()) || !Number.isSafeInteger(resultId) || resultId <= 0) {
    throw new CliError(`--result-id must be a positive whole number, got '${resultIdArg}'.`);
  }

  return resultId;
}

export default artifactsCommand;
