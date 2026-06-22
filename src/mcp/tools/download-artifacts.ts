import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ReportDownloadService } from '../../services/report-download.service';
import { getContext, logStderr } from '../context';
import { jsonResult, runTool } from '../helpers';

/**
 * Download a completed run's artifacts (zip) and/or a formatted report to local
 * disk. This reads cloud state and writes files locally — it does not change
 * anything cloud-side, so it stays available in read-only mode.
 *
 * The underlying service swallows download failures into `warnLogger` rather
 * than throwing (a missing-artifacts 404 isn't fatal), so we collect those
 * warnings and return them — an empty `warnings` array means success.
 */
export function registerDownloadArtifacts(server: McpServer): void {
  server.registerTool(
    'dcd_download_artifacts',
    {
      title: 'Download run artifacts',
      description:
        'Download a completed test run\'s artifacts (videos/logs zip) and/or a formatted report to local disk. ' +
        'Returns the resolved output paths and any warnings (a non-empty warnings array means a download could not be produced, e.g. no results yet).',
      inputSchema: {
        uploadId: z.string().describe('UUID of the upload to download artifacts for'),
        type: z
          .enum(['ALL', 'FAILED'])
          .optional()
          .describe('Which tests to include artifacts for (default ALL)'),
        artifactsPath: z
          .string()
          .optional()
          .describe('Local path to write the artifacts zip (default ./artifacts.zip)'),
        report: z
          .enum(['junit', 'allure', 'html'])
          .optional()
          .describe('Also download a formatted report of this type'),
        reportPath: z
          .string()
          .optional()
          .describe('Local path for the report file (defaults depend on report type)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool('dcd_download_artifacts', async () => {
        const { apiUrl, auth } = await getContext();
        const service = new ReportDownloadService();
        const warnings: string[] = [];
        const warnLogger = (m: string) => {
          warnings.push(m);
          logStderr(m);
        };

        const artifactsPath = args.artifactsPath ?? './artifacts.zip';
        await service.downloadArtifacts({
          apiUrl,
          auth,
          uploadId: args.uploadId,
          downloadType: args.type ?? 'ALL',
          artifactsPath,
          logger: logStderr,
          warnLogger,
        });

        let reportPath: string | undefined;
        if (args.report) {
          reportPath = args.reportPath
            ? path.resolve(args.reportPath)
            : path.resolve(
                args.report === 'junit'
                  ? 'report.xml'
                  : 'report.html',
              );
          await service.downloadReports({
            apiUrl,
            auth,
            uploadId: args.uploadId,
            reportType: args.report,
            junitPath: args.report === 'junit' ? reportPath : undefined,
            allurePath: args.report === 'allure' ? reportPath : undefined,
            htmlPath: args.report === 'html' ? reportPath : undefined,
            logger: logStderr,
            warnLogger,
          });
        }

        return jsonResult({
          uploadId: args.uploadId,
          artifactsPath: path.resolve(artifactsPath),
          reportPath,
          warnings,
        });
      }),
  );
}
