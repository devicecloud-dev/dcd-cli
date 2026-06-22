import * as path from 'node:path';

import { ApiGateway } from '../gateways/api-gateway.js';
import {
  RealtimeResultsGateway,
  type RealtimeResultsSubscription,
} from '../gateways/realtime-gateway.js';
import { formatDurationSeconds } from '../methods.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import { paths } from '../types/generated/schema.types.js';
import { checkInternetConnectivity } from '../utils/connectivity.js';
import { ux } from '../utils/progress.js';
import { colors, formatTestSummary, table } from '../utils/styling.js';

type TestResult = NonNullable<
  paths['/results/{uploadId}']['get']['responses']['200']['content']['application/json']['results']
>[number];

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
  // The run keeps executing in the cloud regardless of whether the CLI can
  // poll, so tolerate a long stretch of transient API/network blips before
  // giving up. Losing a run to a brief hiccup is far more costly than waiting a
  // bit longer.
  private readonly MAX_SEQUENTIAL_FAILURES = 30;
  // Backstop poll cadence. Logged-in (bearer) users also get realtime pushes
  // (see RealtimeResultsGateway), so they only need an occasional reconciling
  // poll; api-key users have no realtime and rely on the faster interval.
  private readonly BEARER_POLL_INTERVAL_MS = 60_000;
  private readonly APIKEY_POLL_INTERVAL_MS = 20_000;
  // Base unit for the backoff applied between *failed* polls, and its cap.
  private readonly ERROR_BACKOFF_BASE_MS = 10_000;
  private readonly MAX_ERROR_BACKOFF_MS = 30_000;

  /**
   * Poll for test results until all tests complete
   * @param options Polling configuration
   * @param testMetadata Optional metadata map for each test (flowName, tags)
   * @returns Promise that resolves with final test results or rejects if tests fail
   */
  public async pollUntilComplete(
    options: PollingOptions,
    testMetadata?: Record<string, TestMetadata>,
  ): Promise<PollingResult> {
    try {
      return await this.pollLoop(options, testMetadata);
    } catch (error) {
      // RunFailedError is a completed run — the spinner was already stopped by
      // displayFinalResults. Anything else aborts mid-poll with the spinner
      // still live, which would corrupt the terminal under the error output.
      if (!options.json && !(error instanceof RunFailedError)) {
        ux.action.stop(colors.error('failed'));
      }
      throw error;
    }
  }

  private async pollLoop(
    options: PollingOptions,
    testMetadata?: Record<string, TestMetadata>,
  ): Promise<PollingResult> {
    const { apiUrl, auth, uploadId, consoleUrl, quiet = false, json = false, debug = false, logger } = options;

    this.initializePollingDisplay(json, logger);

    let sequentialPollFailures = 0;
    let previousSummary = '';

    const pollIntervalMs =
      auth.mode === 'bearer'
        ? this.BEARER_POLL_INTERVAL_MS
        : this.APIKEY_POLL_INTERVAL_MS;

    // "Poke" mechanism: a realtime change resolves the current inter-poll wait
    // early. If a poke lands while we're mid-fetch (not waiting) it's latched
    // and consumed by the next wait, so events are never silently dropped.
    let resolveWake: (() => void) | null = null;
    let pendingPoke = false;
    const poke = () => {
      if (resolveWake) {
        const r = resolveWake;
        resolveWake = null;
        r();
      } else {
        pendingPoke = true;
      }
    };
    const waitForNextPoll = (ms: number): Promise<void> => {
      if (pendingPoke) {
        pendingPoke = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resolveWake = null;
          resolve();
        }, ms);
        resolveWake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    };

    // Realtime is a latency optimisation over the backstop poll; only logged-in
    // (bearer) users can authenticate the socket under RLS. Any failure inside
    // the gateway degrades silently to pure polling.
    let subscription: RealtimeResultsSubscription | undefined;
    if (auth.mode === 'bearer' && auth.accessToken && auth.orgId && auth.env) {
      subscription = RealtimeResultsGateway.subscribe({
        accessToken: auth.accessToken,
        debug,
        env: auth.env,
        log: logger,
        onChange: poke,
        orgId: auth.orgId,
        uploadId,
      });
      if (debug && logger) {
        logger(
          `[DEBUG] Realtime enabled; backstop poll every ${pollIntervalMs / 1000}s`,
        );
      }
    }

    if (debug && logger) {
      logger(`[DEBUG] Starting polling loop for results`);
    }

    try {
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

          // Wait for the next backstop poll, or a realtime poke, whichever comes
          // first.
          await waitForNextPoll(pollIntervalMs);
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
            uploadId,
          );

          // Back off (capped) before retrying so a flaky API gets some breathing
          // room instead of being hammered on every failure.
          await this.sleep(
            Math.min(
              this.ERROR_BACKOFF_BASE_MS * sequentialPollFailures,
              this.MAX_ERROR_BACKOFF_MS,
            ),
          );
        }
      }
    } finally {
      if (subscription) {
        if (debug && logger) {
          logger('[DEBUG] Closing realtime subscription');
        }
        await subscription.unsubscribe();
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
      // Anything other than an explicit pass (CANCELLED, ERROR, a status we
      // don't know about yet) must fail the run — this gates CI exit codes.
      status: resultsWithoutEarlierTries.every((result) => result.status === 'PASSED')
        ? 'PASSED'
        : 'FAILED',
      tests: resultsWithoutEarlierTries.map((r) => ({
        durationSeconds: r.duration_seconds ?? null,
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

    // An empty array would otherwise read as "all complete, all passed".
    if (!updatedResults || updatedResults.length === 0) {
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
    // Resolve each row to the root of its retry chain (a retry's `retry_of`
    // may point at the previous retry rather than the original attempt), then
    // keep only the newest row per root.
    const byId = new Map(results.map((result) => [result.id, result]));
    const rootIdOf = (result: TestResult): TestResult['id'] => {
      let current = result;
      const seen = new Set<TestResult['id']>([current.id]);
      while (current.retry_of) {
        const parent = byId.get(current.retry_of);
        if (!parent || seen.has(parent.id)) return current.retry_of;
        seen.add(parent.id);
        current = parent;
      }
      return current.id;
    };
    const latestByRoot = new Map<TestResult['id'], TestResult>();
    for (const result of results) {
      const rootId = rootIdOf(result);
      const existing = latestByRoot.get(rootId);
      if (!existing || result.id > existing.id) {
        latestByRoot.set(rootId, result);
      }
    }
    return results.filter((result) => latestByRoot.get(rootIdOf(result)) === result);
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
    uploadId?: string,
  ): Promise<void> {
    // The run is unaffected by our inability to poll — always point the user at
    // how to reconnect to it rather than leaving them thinking it died.
    const resumeHint = uploadId
      ? `\n\nThe test is still running in the cloud. Reconnect with:\n  dcd status --upload-id ${uploadId}`
      : '';
    if (debug && logger) {
      logger(`[DEBUG] Error polling for results: ${error}`);
      logger(`[DEBUG] Sequential poll failures: ${sequentialPollFailures}`);
    }

    if (sequentialPollFailures >= this.MAX_SEQUENTIAL_FAILURES) {
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
          `Unable to fetch results after ${this.MAX_SEQUENTIAL_FAILURES} attempts.\n\nInternet connectivity check failed - all test endpoints unreachable:\n${endpointDetails}\n\nPlease verify your network connection and DNS resolution.${resumeHint}`,
        );
      }

      throw new Error(
        `unable to fetch results after ${this.MAX_SEQUENTIAL_FAILURES} attempts${resumeHint}`,
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
