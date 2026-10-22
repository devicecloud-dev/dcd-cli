import { defineCommand } from 'citty';

import { apiFlags } from '../config/flags/api.flags.js';
import { jsonFlag } from '../config/flags/output.flags.js';
import {
  type DownloadResult,
  ReportDownloadService,
} from '../services/report-download.service.js';
import { resolveAuth } from '../utils/auth.js';
import { CliError, logger, validateEnum } from '../utils/cli.js';
import { resolveApiUrl } from '../utils/config-store.js';

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
    report: {
      type: 'string',
      description:
        'Download a test report in the specified format (options: allure, html, html-detailed, junit)',
    },
    'allure-path': {
      type: 'string',
      description:
        'Custom file path for downloaded Allure report (default: ./report.html)',
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

    const service = new ReportDownloadService();
    const downloads: DownloadResult[] = [];

    if (downloadArtifacts) {
      downloads.push(await service.downloadArtifacts({
        auth,
        apiUrl,
        artifactsPath: artifactsPath ?? './artifacts.zip',
        debug,
        downloadType: downloadArtifacts,
        logger: log,
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

    if (json) {
      const ok = downloads.some((d) => d.ok);
      logger.json({ status: ok ? 'SUCCESS' : 'FAILED', uploadId, downloads });
      // Same exit code a thrown error would give, without a second JSON object.
      if (!ok) logger.fail('Every download failed', 1);
    }
  },
});

export default artifactsCommand;
