import { defineCommand } from 'citty';

import { apiFlags } from '../config/flags/api.flags';
import { ReportDownloadService } from '../services/report-download.service';
import { resolveAuth } from '../utils/auth';
import { CliError, logger, validateEnum } from '../utils/cli';

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
        'Custom file path for downloaded HTML report (default: ./report.html)',
    },
    'junit-path': {
      type: 'string',
      description:
        'Custom file path for downloaded JUnit report (default: ./report.xml)',
    },
  },
  async run({ args }) {
    const apiKeyFlag = args['api-key'] as string | undefined;
    const apiUrl = args['api-url'] as string;
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

    if (downloadArtifacts) {
      await service.downloadArtifacts({
        auth,
        apiUrl,
        artifactsPath: artifactsPath ?? './artifacts.zip',
        debug,
        downloadType: downloadArtifacts,
        logger: (m: string) => logger.log(m),
        uploadId,
        warnLogger: (m: string) => logger.warn(m),
      });
    }

    if (report) {
      await service.downloadReports({
        allurePath,
        auth,
        apiUrl,
        debug,
        htmlPath,
        junitPath,
        logger: (m: string) => logger.log(m),
        reportType: report,
        uploadId,
        warnLogger: (m: string) => logger.warn(m),
      });
    }
  },
});

export default artifactsCommand;
