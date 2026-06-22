import * as path from 'node:path';

import { ApiGateway } from '../gateways/api-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';

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
}

export interface ReportDownloadOptions extends DownloadOptions {
  allurePath?: string;
  htmlPath?: string;
  junitPath?: string;
  reportType: 'allure' | 'html' | 'html-detailed' | 'junit';
}

/**
 * Service for downloading test artifacts and reports
 */
export class ReportDownloadService {
  /**
   * Download test artifacts as a zip file
   * @param options Download configuration
   * @returns Promise that resolves when download is complete
   */
  public async downloadArtifacts(
    options: ArtifactsDownloadOptions,
  ): Promise<void> {
    const {
      apiUrl,
      auth,
      uploadId,
      downloadType,
      artifactsPath = './artifacts.zip',
      debug = false,
      logger,
      warnLogger,
    } = options;

    try {
      if (debug && logger) {
        logger(`[DEBUG] Downloading artifacts: ${downloadType}`);
      }

      await ApiGateway.downloadArtifactsZip(
        apiUrl,
        auth,
        uploadId,
        downloadType,
        artifactsPath,
      );

      if (logger) {
        logger('\n');
        logger(
          `Test artifacts have been downloaded to ${artifactsPath}`,
        );
      }
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
    }
  }

  /**
   * Handle downloading reports based on the report type specified
   * @param options Report download configuration
   * @returns Promise that resolves when download is complete
   */
  public async downloadReports(
    options: ReportDownloadOptions,
  ): Promise<void> {
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
        await this.downloadReport('junit', reportPath, {
          ...downloadOptions,
          warnLogger,
        });
        break;
      }

      case 'allure': {
        const reportPath = path.resolve(process.cwd(), allurePath || 'report.html');
        await this.downloadReport('allure', reportPath, {
          ...downloadOptions,
          warnLogger,
        });
        break;
      }

      case 'html':
      case 'html-detailed': {
        const htmlReportPath = path.resolve(process.cwd(), htmlPath || 'report.html');
        await this.downloadReport('html', htmlReportPath, {
          ...downloadOptions,
          warnLogger,
        });
        break;
      }

      default: {
        if (warnLogger) {
          warnLogger(`Unknown report type: ${reportType}`);
        }
      }
    }
  }

  /**
   * Download a specific report type
   * @param type Report type to download
   * @param filePath Path where report should be saved
   * @param options Download configuration
   * @returns Promise that resolves when download is complete
   */
  private async downloadReport(
    type: 'allure' | 'html' | 'junit',
    filePath: string,
    options: DownloadOptions,
  ): Promise<void> {
    const { apiUrl, auth, uploadId, debug = false, logger, warnLogger } = options;

    try {
      if (debug && logger) {
        logger(`[DEBUG] Downloading ${type.toUpperCase()} report`);
      }

      await ApiGateway.downloadReportGeneric(
        apiUrl,
        auth,
        uploadId,
        type,
        filePath,
      );

      if (logger) {
        logger(
          `${type.toUpperCase()} test report has been downloaded to ${filePath}`,
        );
      }
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

    const errorMessage = error instanceof Error ? error.message : String(error);
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
