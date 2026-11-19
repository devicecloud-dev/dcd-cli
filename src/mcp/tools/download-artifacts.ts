import { existsSync } from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ReportDownloadService } from '../../services/report-download.service.js';
import { getContext, logStderr } from '../context.js';
import { jsonResult, runTool } from '../helpers.js';
import { localOutput, markWritten } from '../local-files.js';

/**
 * Download a completed run's artifacts (zip) and/or a formatted report to local
 * disk. This reads cloud state and writes files locally — it does not change
 * anything cloud-side, so it stays available in read-only mode. It does write
 * files, so it is not annotated read-only: the files go inside the working
 * directory only, and never over a file this server did not write
 * (local-files.ts).
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
        'Paths are relative to the working directory this server runs in, and must stay inside it; an existing file this server did not write is never replaced. ' +
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
          .describe('Where to write the artifacts zip, inside the working directory (default ./artifacts.zip)'),
        resultId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Only this result's artifacts: its flow's attempts on that one device. Leave unset with flow.",
          ),
        flow: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only the artifacts of the flow with this file path or name (e.g. flows/login.yaml or login). A name matching several results (one per device) gives a warning listing their ids; pass one as resultId.',
          ),
        report: z
          .enum(['junit', 'allure', 'html'])
          .optional()
          .describe(
            'Also download a formatted report of this type. allure is deprecated and will be removed on 7 December 2026; prefer junit or html.',
          ),
        reportPath: z
          .string()
          .optional()
          .describe(
            'Where to write the report, inside the working directory (default ./report.xml for junit, ./report.html for allure, ./report.zip for html, which is a ZIP of report.html and its assets)',
          ),
      },
      // It writes local files (nothing in the cloud), and never over one it did not write.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool('dcd_download_artifacts', async () => {
        if (args.resultId !== undefined && args.flow !== undefined) {
          throw new Error('Pass resultId or flow, not both');
        }

        const { apiUrl, auth } = await getContext();
        const service = new ReportDownloadService();
        const warnings: string[] = [];
        const warnLogger = (m: string) => {
          warnings.push(m);
          logStderr(m);
        };

        // Both checked before anything is downloaded.
        const artifactsPath = localOutput(args.artifactsPath ?? './artifacts.zip');
        const defaultReportPath = args.report
          ? { allure: 'report.html', html: 'report.zip', junit: 'report.xml' }[args.report]
          : undefined;
        const reportPath = defaultReportPath ? localOutput(args.reportPath || defaultReportPath) : undefined;
        if (reportPath && reportPath === artifactsPath) {
          throw new Error('artifactsPath and reportPath name the same file. Give them different paths.');
        }

        await service.downloadArtifacts({
          apiUrl,
          auth,
          uploadId: args.uploadId,
          downloadType: args.type ?? 'ALL',
          artifactsPath,
          flow: args.flow,
          resultId: args.resultId,
          logger: logStderr,
          warnLogger,
        });
        if (existsSync(artifactsPath)) markWritten(artifactsPath);

        // The HTML report is a ZIP of report.html plus assets; Allure's is a
        // single HTML file.
        if (args.report && reportPath) {
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
          if (existsSync(reportPath)) markWritten(reportPath);
        }

        return jsonResult({
          uploadId: args.uploadId,
          artifactsPath,
          reportPath,
          warnings,
        });
      }),
  );
}
