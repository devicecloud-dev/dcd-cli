import * as path from 'node:path';

import { ApiGateway } from '../gateways/api-gateway';
import { formatDurationSeconds } from '../methods';
import type { AuthContext } from '../types/domain/auth.types';
import { paths } from '../types/generated/schema.types';
import { checkInternetConnectivity } from '../utils/connectivity';
import { ux } from '../utils/progress';
import { colors, formatTestSummary, table } from '../utils/styling';

type TestResult =
  paths['/results/{uploadId}']['get']['responses']['200']['content']['application/json']['results'][number];

/**
 * Custom error for run failures that includes the polling result
 */
export class RunFailedError extends Error {
  constructor(public result: PollingResult) {
    super('RUN_FAILED');
    this.name = 'RunFailedError';
  }
}

export interface PollingOptions {
  auth: AuthContext;
  apiUrl: string;
  consoleUrl: string;
  debug?: boolean;
  json?: boolean;
  logger?: (message: string) => void;
  quiet?: boolean;
  uploadId: string;
}

/** Metadata for a test flow extracted from YAML config */
export interface TestMetadata {
  /** Flow name from YAML config 'name' field or filename without extension */
  flowName: string;
  /** Tags from YAML config 'tags' field */
  tags: string[];
}

export interface PollingResult {
  consoleUrl: string;
  status: 'FAILED' | 'PASSED';
  tests: Array<{
    durationSeconds: null | number;
    failReason?: string;
    /** File path of the test (same as name, for clarity) */
    fileName: string;
    /** Flow name from YAML config or filename without extension */
    flowName: string;
    /** Test file name (unchanged for backwards compatibility) */
    name: string;
    status: string;
    /** Tags from YAML config (empty array if none) */
    tags: string[];
  }>;
  uploadId: string;
}

/**
 * Service for polling test results from the API
 */
export class ResultsPollingService {
  private readonly MAX_SEQUENTIAL_FAILURES = 10;
  private readonly POLL_INTERVAL_MS = 10_000;

  /**
   * Poll for test results until all tests complete
   * @param results Initial test results from submission
   * @param options Polling configuration
   * @param testMetadata Optional metadata map for each test (flowName, tags)
   * @returns Promise that resolves with final test results or rejects if tests fail
   */
  public async pollUntilComplete(
    results: TestResult[],
    options: PollingOptions,
    testMetadata?: Record<string, TestMetadata>,
  ): Promise<PollingResult> {
    const { apiUrl, auth, uploadId, consoleUrl, quiet = false, json = false, debug = false, logger } = options;

    this.initializePollingDisplay(json, logger);

    let sequentialPollFailures = 0;
    let previousSummary = '';

    if (debug && logger) {
      logger(`[DEBUG] Starting polling loop for results`);
    }

    // Poll in a loop until all tests complete
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const updatedResults = await this.fetchAndLogResults(apiUrl, auth, uploadId, debug, logger);

        const { summary } = this.calculateStatusSummary(updatedResults);
        previousSummary = this.updateDisplayStatus(
          updatedResults,
          quiet,
          json,
          summary,
          previousSummary,
        );

        const allComplete = updatedResults.every(
          (result) => !['PENDING', 'QUEUED', 'RUNNING'].includes(result.status),
        );

        if (allComplete) {
          return await this.handleCompletedTests(updatedResults, {
            consoleUrl,
            debug,
            json,
            logger,
            testMetadata,
            uploadId,
          });
        }

        // Reset failure counter on successful poll
        sequentialPollFailures = 0;

        // Wait before next poll
        await this.sleep(this.POLL_INTERVAL_MS);
      } catch (error) {
        // Re-throw RunFailedError immediately (test failures, not polling errors)
        if (error instanceof RunFailedError) {
          throw error;
        }

        sequentialPollFailures++;

        // Handle polling errors (network issues, etc.)
        await this.handlePollingError(
          error,
          sequentialPollFailures,
          debug,
          logger,
        );

        // Wait before retrying after an error
        await this.sleep(this.POLL_INTERVAL_MS);
      }
    }
  }

  private buildPollingResult(
    results: TestResult[],
    uploadId: string,
    consoleUrl: string,
    testMetadata?: Record<string, TestMetadata>,
  ): PollingResult {
    const resultsWithoutEarlierTries = this.filterLatestResults(results);

    return {
      consoleUrl,
      status: resultsWithoutEarlierTries.some((result) => result.status === 'FAILED')
        ? 'FAILED'
        : 'PASSED',
      tests: resultsWithoutEarlierTries.map((r) => ({
        durationSeconds: r.duration_seconds,
        failReason:
          r.status === 'FAILED' ? r.fail_reason || 'No reason provided' : undefined,
        fileName: r.test_file_name,
        flowName: testMetadata?.[r.test_file_name]?.flowName || path.parse(r.test_file_name).name,
        name: r.test_file_name,
        status: r.status,
        tags: testMetadata?.[r.test_file_name]?.tags || [],
      })),
      uploadId,
    };
  }

  private calculateStatusSummary(results: TestResult[]): {
    completed: number;
    failed: number;
    passed: number;
    pending: number;
    queued: number;
    running: number;
    summary: string;
    total: number;
  } {
    const statusCounts: Record<string, number> = {};
    for (const result of results) {
      statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;
    }

    const passed = statusCounts.PASSED || 0;
    const failed = statusCounts.FAILED || 0;
    const pending = statusCounts.PENDING || 0;
    const queued = statusCounts.QUEUED || 0;
    const running = statusCounts.RUNNING || 0;
    const total = results.length;
    const completed = passed + failed;

    const summary = formatTestSummary({
      completed,
      failed,
      passed,
      pending,
      queued,
      running,
      total,
    });

    return { completed, failed, passed, pending, queued, running, summary, total };
  }

  private displayFinalResults(
    results: TestResult[],
    consoleUrl: string,
    json: boolean,
    logger?: (message: string) => void,
  ): void {
    if (json) {
      return;
    }

    ux.action.stop(colors.success('completed'));
    if (logger) {
      logger('\n');
    }

    const hasFailedTests = results.some((result) => result.status === 'FAILED');
    table(
      results,
      {
        duration: {
          get(row) {
            return row.duration_seconds
              ? colors.dim(formatDurationSeconds(Number(row.duration_seconds)))
              : colors.dim('-');
          },
        },
        status: {
          get(row) {
            const statusUpper = row.status.toUpperCase();
            switch (statusUpper) {
              case 'PASSED': {
                return colors.success(row.status);
              }

              case 'FAILED': {
                return colors.error(row.status);
              }

              case 'RUNNING': {
                return colors.info(row.status);
              }

              case 'PENDING': {
                return colors.warning(row.status);
              }

              case 'QUEUED': {
                return colors.dim(row.status);
              }

              default: {
                return colors.dim(row.status);
              }
            }
          },
        },
        test: {
          get(row) {
            const testName = row.test_file_name;
            const retry = row.retry_of ? colors.dim(' (retry)') : '';
            return `${testName}${retry}`;
          },
        },
        ...(hasFailedTests && {
          // eslint-disable-next-line camelcase
          fail_reason: {
            get(row) {
              return row.status === 'FAILED' && row.fail_reason
                ? colors.error(row.fail_reason)
                : '';
            },
          },
        }),
      },
      { printLine: logger },
    );

    if (logger) {
      logger('\n');
      logger(colors.bold('Run completed') + colors.dim(', you can access the results at:'));
      logger(colors.url(consoleUrl));
      logger('\n');
    }
  }

  /**
   * Fetch results from API and log debug information
   * @param apiUrl API base URL
   * @param auth AuthContext carrying request headers
   * @param uploadId Upload ID to fetch results for
   * @param debug Whether debug logging is enabled
   * @param logger Optional logger function
   * @returns Promise resolving to test results
   */
  private async fetchAndLogResults(
    apiUrl: string,
    auth: AuthContext,
    uploadId: string,
    debug: boolean,
    logger?: (message: string) => void,
  ): Promise<TestResult[]> {
    if (debug && logger) {
      logger(`[DEBUG] Polling for results: ${uploadId}`);
    }

    const { results: updatedResults } =
      await ApiGateway.getResultsForUpload(apiUrl, auth, uploadId);

    if (!updatedResults) {
      throw new Error('no results');
    }

    if (debug && logger) {
      logger(`[DEBUG] Poll received ${updatedResults.length} results`);
      for (const result of updatedResults) {
        logger(
          `[DEBUG] Result status: ${result.test_file_name} - ${result.status}`,
        );
      }
    }

    return updatedResults;
  }

  private filterLatestResults(results: TestResult[]): TestResult[] {
    return results.filter((result) => {
      const originalTryId = result.retry_of || result.id;
      const tries = results.filter(
        (r) => r.retry_of === originalTryId || r.id === originalTryId,
      );
      return result.id === Math.max(...tries.map((t) => t.id));
    });
  }

  /**
   * Handle completed tests and return final result
   * @param updatedResults Test results from API
   * @param options Completion handling options
   * @returns Promise resolving to final polling result
   */
  private async handleCompletedTests(
    updatedResults: TestResult[],
    options: {
      consoleUrl: string;
      debug: boolean;
      json: boolean;
      logger?: (message: string) => void;
      testMetadata?: Record<string, TestMetadata>;
      uploadId: string;
    },
  ): Promise<PollingResult> {
    const { uploadId, consoleUrl, json, debug, logger, testMetadata } = options;

    if (debug && logger) {
      logger(`[DEBUG] All tests completed, stopping poll`);
    }

    this.displayFinalResults(updatedResults, consoleUrl, json, logger);

    const output = this.buildPollingResult(
      updatedResults,
      uploadId,
      consoleUrl,
      testMetadata,
    );

    if (output.status === 'FAILED') {
      if (debug && logger) {
        logger(`[DEBUG] Some tests failed, returning failed status`);
      }

      throw new RunFailedError(output);
    }

    if (debug && logger) {
      logger(`[DEBUG] All tests passed, returning success status`);
    }

    return output;
  }

  private async handlePollingError(
    error: unknown,
    sequentialPollFailures: number,
    debug: boolean,
    logger?: (message: string) => void,
  ): Promise<void> {
    if (debug && logger) {
      logger(`[DEBUG] Error polling for results: ${error}`);
      logger(`[DEBUG] Sequential poll failures: ${sequentialPollFailures}`);
    }

    if (sequentialPollFailures > this.MAX_SEQUENTIAL_FAILURES) {
      if (debug && logger) {
        logger('[DEBUG] Checking internet connectivity...');
      }

      const connectivityCheck = await checkInternetConnectivity();

      if (debug && logger) {
        logger(`[DEBUG] ${connectivityCheck.message}`);
        for (const result of connectivityCheck.endpointResults) {
          if (result.success) {
            logger(
              `[DEBUG] ✓ ${result.endpoint} - ${result.statusCode} (${result.latencyMs}ms)`,
            );
          } else {
            logger(
              `[DEBUG] ✗ ${result.endpoint} - ${result.error} (${result.latencyMs}ms)`,
            );
          }
        }
      }

      if (!connectivityCheck.connected) {
        const endpointDetails = connectivityCheck.endpointResults
          .map((r) => `  - ${r.endpoint}: ${r.error} (${r.latencyMs}ms)`)
          .join('\n');

        throw new Error(
          `Unable to fetch results after ${this.MAX_SEQUENTIAL_FAILURES} attempts.\n\nInternet connectivity check failed - all test endpoints unreachable:\n${endpointDetails}\n\nPlease verify your network connection and DNS resolution.`,
        );
      }

      throw new Error(
        `unable to fetch results after ${this.MAX_SEQUENTIAL_FAILURES} attempts`,
      );
    }

    if (logger) {
      logger('unable to fetch results, trying again...');
    }
  }

  /**
   * Initialize the polling display UI
   * @param json Whether to output in JSON format
   * @param logger Optional logger function for output
   * @returns void
   */
  private initializePollingDisplay(
    json: boolean,
    logger?: (message: string) => void,
  ): void {
    if (!json) {
      ux.action.start(colors.bold('Waiting for results'), colors.dim('Initializing'), {
        stdout: true,
      });
      if (logger) {
        logger(
          colors.dim('\nYou can safely close this terminal and the tests will continue\n'),
        );
      }
    }
  }

  /**
   * Sleep for the specified number of milliseconds
   * @param ms Number of milliseconds to sleep
   * @returns Promise that resolves after the delay
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private updateDisplayStatus(
    results: TestResult[],
    quiet: boolean,
    json: boolean,
    summary: string,
    previousSummary: string,
  ): string {
    if (json) {
      return previousSummary;
    }

    if (quiet) {
      if (summary !== previousSummary) {
        ux.action.status = summary;
        return summary;
      }
    } else {
      ux.action.status = colors.dim('\nStatus      Test\n─────────── ───────────────');
      for (const {
        retry_of: isRetry,
        status,
        test_file_name: test,
      } of results) {
        const statusFormatted = status.toUpperCase() === 'PASSED'
          ? colors.success(status.padEnd(10, ' '))
          : status.toUpperCase() === 'FAILED'
          ? colors.error(status.padEnd(10, ' '))
          : status.toUpperCase() === 'RUNNING'
          ? colors.info(status.padEnd(10, ' '))
          : status.toUpperCase() === 'QUEUED'
          ? colors.dim(status.padEnd(10, ' '))
          : colors.warning(status.padEnd(10, ' '));
        const retryText = isRetry ? colors.dim(' (retry)') : '';
        ux.action.status += `\n${statusFormatted}  ${test}${retryText}`;
      }
    }

    return previousSummary;
  }
}
