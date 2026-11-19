import * as path from 'node:path';

import { ApiGateway } from '../gateways/api-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import { refreshAuth } from '../utils/auth.js';
import { deviceFromResultRow } from './results-polling.service.js';

export interface DownloadOptions {
  auth: AuthContext;
  apiUrl: string;
  debug?: boolean;
  logger?: (message: string) => void;
  uploadId: string;
  warnLogger?: (message: string) => void;
}

export interface ArtifactsDownloadOptions extends DownloadOptions {
  artifactsPath?: string;
  downloadType: 'ALL' | 'FAILED';
  /**
   * Only this flow's artifacts, by its file path or name: resolved to one
   * result with {@link matchFlowResult}. Leave unset with `resultId`.
   */
  flow?: string;
  /**
   * Only the artifacts of the flow run this result belongs to: its first
   * attempt and every retry, on that one device.
   */
  resultId?: number;
}

/** A result row as the flow lookup needs it. */
export interface FlowResultRow {
  config?: unknown;
  id: number;
  retry_of?: null | number;
  simulator_name?: null | string;
  test_file_name: string;
}

/** `./flows/login.yaml` -> `flows/login.yaml`, so the forms compare equal. */
const normaliseFlowPath = (p: string) => p.trim().replace(/^(\.\/)+/, '');

/**
 * The one run in an upload whose flow file matches `flow`: its full path as
 * submitted (`flows/login.yaml`, with or without `./`), its file name
 * (`login.yaml`) or its name without the extension (`login`). Only first
 * attempts are candidates; the API adds the retries. Throws when nothing
 * matches, or when several runs do (a device matrix runs one flow per
 * device), listing the result ids to pick from with --result-id.
 */
export function matchFlowResult(rows: FlowResultRow[], flow: string): number {
  const wanted = normaliseFlowPath(flow);
  const roots = rows.filter((r) => r.retry_of === null || r.retry_of === undefined);
  const matches = roots.filter((r) => {
    const file = normaliseFlowPath(r.test_file_name);
    const base = file.split('/').pop() ?? file;
    return file === wanted || base === wanted || base.replace(/\.ya?ml$/i, '') === wanted;
  });

  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) {
    throw new Error(`No flow matching '${flow}' in this upload`);
  }

  const candidates = matches.map((r) => {
    const device = deviceFromResultRow(r);
    const label = [device?.name, device?.osVersion].filter(Boolean).join(' ');
    return `${r.id} (${r.test_file_name}${label ? `, ${label}` : ''})`;
  });
  throw new Error(
    `'${flow}' matches ${matches.length} results in this upload; pick one with --result-id: ${candidates.join(', ')}`,
  );
}

export interface ReportDownloadOptions extends DownloadOptions {
  allurePath?: string;
  htmlPath?: string;
  junitPath?: string;
  reportType: 'allure' | 'html' | 'html-detailed' | 'junit';
}

/**
 * The report formats retired on 7 December 2026, and what each one
 * does from that date. `dcd cloud` users are told by the API's submit message
 * and a notice; `dcd artifacts` fetches neither, so it prints this itself.
 * The values stay valid after the date: a run that asks for one must not fail.
 */
export function reportFormatDeprecation(
  report: string | undefined,
): string | undefined {
  switch (report) {
    case 'allure': {
      return '--report allure is deprecated and will be removed on 7 December 2026. From that date runs get no Allure report. Use --report html or --report junit instead.';
    }

    case 'html-detailed': {
      return '--report html-detailed is deprecated and will be removed on 7 December 2026. From that date it gives the standard HTML report. Use --report html instead.';
    }

    default: {
      return undefined;
    }
  }
}

/** What one download attempt did; failures are warned about, not thrown. */
export interface DownloadResult {
  error?: string;
  ok: boolean;
  path: string;
  type: 'allure' | 'artifacts' | 'html' | 'junit';
}

/**
 * Whether every requested download succeeded. `dcd artifacts` exits 1 when
 * not; `dcd cloud` only warns, so a download never changes a test-run exit.
 */
export function downloadsSucceeded(downloads: DownloadResult[]): boolean {
  return downloads.length > 0 && downloads.every((d) => d.ok);
}

/**
 * Service for downloading test artifacts and reports
 */
export class ReportDownloadService {
  /**
   * Download test artifacts as a zip file
   * @param options Download configuration
   * @returns What the download did
   */
  public async downloadArtifacts(
    options: ArtifactsDownloadOptions,
  ): Promise<DownloadResult> {
    const {
      apiUrl,
      auth,
      uploadId,
      downloadType,
      artifactsPath = './artifacts.zip',
      debug = false,
      flow,
      logger,
      warnLogger,
    } = options;

    try {
      if (debug && logger) {
        logger(`[DEBUG] Downloading artifacts: ${downloadType}`);
      }

      // `dcd cloud` downloads after polling, which can outlast a `dcd login`
      // token; a failed refresh lands in the warning below like any failure.
      const freshAuth = await refreshAuth(auth);

      // A flow name becomes the result id the API filters on. A name that
      // matches nothing, or several runs, lands in the warning below.
      let { resultId } = options;
      if (flow !== undefined) {
        const { results } = (await ApiGateway.getResultsForUpload(
          apiUrl,
          freshAuth,
          uploadId,
        )) as { results?: FlowResultRow[] };
        resultId = matchFlowResult(results ?? [], flow);
        if (debug && logger) {
          logger(`[DEBUG] Flow '${flow}' is result ${resultId}`);
        }
      }

      await ApiGateway.downloadArtifactsZip(
        apiUrl,
        freshAuth,
        uploadId,
        downloadType,
        artifactsPath,
        resultId,
      );

      if (logger) {
        logger('\n');
        logger(
          `Test artifacts have been downloaded to ${artifactsPath}`,
        );
      }

      return { ok: true, path: artifactsPath, type: 'artifacts' };
    } catch (error) {
      if (debug && logger) {
        logger(`[DEBUG] Error downloading artifacts: ${error}`);
      }

      this.warnDownloadFailure(
        warnLogger,
        'artifacts',
        'No artifacts found for this upload. Make sure your tests generated results.',
        error,
      );

      return { error: errorText(error), ok: false, path: artifactsPath, type: 'artifacts' };
    }
  }

  /**
   * Handle downloading reports based on the report type specified
   * @param options Report download configuration
   * @returns What the download did, or undefined for an unknown report type
   */
  public async downloadReports(
    options: ReportDownloadOptions,
  ): Promise<DownloadResult | undefined> {
    const {
      reportType,
      junitPath,
      allurePath,
      htmlPath,
      warnLogger,
      ...downloadOptions
    } = options;

    switch (reportType) {
      case 'junit': {
        const reportPath = path.resolve(process.cwd(), junitPath || 'report.xml');
        return this.downloadReport('junit', reportPath, {
          ...downloadOptions,
          warnLogger,
        });
      }

      case 'allure': {
        const reportPath = path.resolve(process.cwd(), allurePath || 'report.html');
        return this.downloadReport('allure', reportPath, {
          ...downloadOptions,
          warnLogger,
        });
      }

      case 'html':
      case 'html-detailed': {
        // The HTML report is a ZIP (report.html plus its screenshots and
        // assets), so the default name says so. An explicit path is kept as-is.
        const htmlReportPath = path.resolve(process.cwd(), htmlPath || 'report.zip');
        return this.downloadReport('html', htmlReportPath, {
          ...downloadOptions,
          warnLogger,
        });
      }

      default: {
        if (warnLogger) {
          warnLogger(`Unknown report type: ${reportType}`);
        }

        return undefined;
      }
    }
  }

  /**
   * Download a specific report type
   * @param type Report type to download
   * @param filePath Path where report should be saved
   * @param options Download configuration
   * @returns What the download did
   */
  private async downloadReport(
    type: 'allure' | 'html' | 'junit',
    filePath: string,
    options: DownloadOptions,
  ): Promise<DownloadResult> {
    const { apiUrl, auth, uploadId, debug = false, logger, warnLogger } = options;

    try {
      if (debug && logger) {
        logger(`[DEBUG] Downloading ${type.toUpperCase()} report`);
      }

      // As for artifacts: this can run after a poll that outlasted the token.
      await ApiGateway.downloadReportGeneric(
        apiUrl,
        await refreshAuth(auth),
        uploadId,
        type,
        filePath,
      );

      if (logger) {
        logger(
          `${type.toUpperCase()} test report has been downloaded to ${filePath}`,
        );
      }

      return { ok: true, path: filePath, type };
    } catch (error) {
      if (debug && logger) {
        logger(`[DEBUG] Error downloading ${type.toUpperCase()} report: ${error}`);
      }

      this.warnDownloadFailure(
        warnLogger,
        `${type.toUpperCase()} report`,
        `No ${type.toUpperCase()} reports found for this upload. Make sure your tests generated results.`,
        error,
      );

      return { error: errorText(error), ok: false, path: filePath, type };
    }
  }

  /**
   * Warn about a failed download with the underlying cause plus hints for
   * common error classes (missing results, permissions, bad paths)
   * @param warnLogger Warning logger, if configured
   * @param subject What was being downloaded, e.g. 'artifacts' or 'JUNIT report'
   * @param notFoundHint Message to show when the error looks like a 404
   * @param error The error that occurred
   * @returns void
   */
  private warnDownloadFailure(
    warnLogger: ((message: string) => void) | undefined,
    subject: string,
    notFoundHint: string,
    error: unknown,
  ): void {
    if (!warnLogger) {
      return;
    }

    const errorMessage = errorText(error);
    warnLogger(`Failed to download ${subject}: ${errorMessage}`);

    if (errorMessage.includes('404')) {
      warnLogger(notFoundHint);
    } else if (errorMessage.includes('EACCES') || errorMessage.includes('EPERM')) {
      warnLogger('Permission denied. Check write permissions for the current directory.');
    } else if (errorMessage.includes('ENOENT')) {
      warnLogger('Directory does not exist. Make sure you have write access to the current directory.');
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
