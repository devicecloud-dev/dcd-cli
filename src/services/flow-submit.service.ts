import { ApiError } from '../gateways/api-gateway.js';
import { isDefinitiveAuthFailure } from '../utils/auth.js';

/**
 * Submitting a flow test when the response may be lost (dcd#1617 follow-up).
 *
 * Supabase's ingress sometimes holds a request for minutes before answering,
 * and Railway's edge cuts a request that is silent for 300s with a 502. Either
 * way the CLI cannot tell whether its run was created. The API makes that safe
 * to find out: it answers a repeat of the same submission (same body, same
 * upload id from getFlowUploadUrl) with the run it already created, or a 409
 * while that run is still being created. It never creates a second run or a
 * second charge. So a submit whose outcome is unknown is simply sent again.
 */

/**
 * Waits before each re-send: 2s, then up to 30s apart, about three minutes in
 * all. That is long enough for a write held in a stall to land, after which the
 * repeat is answered with the run.
 */
export const SUBMIT_RETRY_DELAYS_MS: readonly number[] = [
  2000, 5000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000,
];

/**
 * No attempt starts more than this long after the first. Each attempt can take
 * up to its 90s timeout, so without a cap every attempt timing out would hold
 * the command for about 16 minutes; with it, the worst case is about 6.5.
 */
export const SUBMIT_RETRY_BUDGET_MS = 5 * 60_000;

/**
 * Statuses that leave the outcome unknown (502/503/504 from the edge or the
 * API), say the API could not finish (500), or say the first attempt is still
 * creating the run (409 SUBMISSION_IN_PROGRESS). Re-sending is only safe
 * because the API dedupes on the upload id.
 */
const RETRYABLE_STATUSES = new Set([409, 500, 502, 503, 504]);

/**
 * Whether a failed attempt is worth sending again. Anything that is not an API
 * answer is a transport failure: a network error, the attempt timeout, or a
 * body that died mid-read after a 2xx. In every case the run may already exist,
 * which a repeat finds out. The npm build throws undici's errors and the bun
 * binaries their own; neither is an ApiError, so both retry.
 */
export function isRetryableSubmitError(error: unknown): boolean {
  if (error instanceof ApiError) return RETRYABLE_STATUSES.has(error.status);
  // The session can't be refreshed (refused, or logged out): only `dcd login`
  // fixes that, so another attempt would fail the same way.
  if (isDefinitiveAuthFailure(error)) return false;
  return true;
}

/** A one-line reason for the retry notice. Network errors carry a long help text. */
export function describeSubmitError(error: unknown): string {
  if (error instanceof ApiError) return `HTTP ${error.status}`;
  if (error instanceof Error) {
    if (error.name === 'SubmitTimeoutError') return 'no response in time';
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string') return code;
    return error.name === 'NetworkError' ? 'network error' : error.name;
  }

  return String(error);
}

/** The API predates the client-direct submit: a real API 404s, some proxies 405. */
export function isSubmitEndpointMissing(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 404 || error.status === 405)
  );
}

export interface SubmitRetryNotice {
  /** The attempt about to be sent, counting from 1. */
  attempt: number;
  attempts: number;
  delayMs: number;
  reason: string;
}

/**
 * Send a submission, sending it again while its outcome is unknown.
 *
 * `fallback` is the legacy multipart submit for an API that predates this
 * endpoint. It is used only when the *first* attempt says the endpoint is
 * missing. A 404 on a later attempt comes from an API that took the earlier
 * attempt, so a multipart submit then would create a second run.
 *
 * Resolves with the response and how many attempts it took. Throws the last
 * error when it is not retryable or the attempts run out.
 */
export async function submitWithRetry<T>(opts: {
  budgetMs?: number;
  delaysMs?: readonly number[];
  fallback: (error: ApiError) => Promise<T>;
  now?: () => number;
  /**
   * Called before each attempt with its number, counting from 1, so a caller
   * can record how many were made whether the submit succeeds or not.
   */
  onAttempt?: (attempt: number) => void;
  onRetry?: (notice: SubmitRetryNotice) => void;
  sleep?: (ms: number) => Promise<void>;
  submit: () => Promise<T>;
}): Promise<{ attempts: number; response: T }> {
  const delaysMs = opts.delaysMs ?? SUBMIT_RETRY_DELAYS_MS;
  const budgetMs = opts.budgetMs ?? SUBMIT_RETRY_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const attempts = delaysMs.length + 1;

  for (let attempt = 1; ; attempt++) {
    opts.onAttempt?.(attempt);
    try {
      return { attempts: attempt, response: await opts.submit() };
    } catch (error) {
      if (attempt === 1 && isSubmitEndpointMissing(error)) {
        return {
          attempts: attempt,
          response: await opts.fallback(error as ApiError),
        };
      }

      const delayMs = delaysMs[attempt - 1];
      if (
        delayMs === undefined ||
        !isRetryableSubmitError(error) ||
        now() - startedAt + delayMs > budgetMs
      ) {
        throw error;
      }

      opts.onRetry?.({
        attempt: attempt + 1,
        attempts,
        delayMs,
        reason: describeSubmitError(error),
      });
      await sleep(delayMs);
    }
  }
}
