/**
 * Retries for direct-to-Backblaze uploads.
 *
 * B2 expects clients to retry: an upload can be answered with 408, 429 or a
 * 5xx, or have its connection dropped, and B2's own guidance is to back off
 * and try again (for a large-file part, on a different upload URL). The CLI
 * used to make exactly one attempt, which was survivable only while the
 * Supabase upload behind it still worked. CLIs older than 5.9.0 lost that
 * fallback when the legacy Supabase key was revoked on 2026-10-22, and a
 * single dropped B2 request then failed the whole run.
 */

export const B2_RETRY = {
  /** Total attempts per request, the first included. */
  attempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

/** A B2 (or S3-compatible) response that was not 2xx. */
export class B2HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'B2HttpError';
  }
}

/**
 * Whether a failed attempt is worth repeating. Network errors (fetch throws a
 * TypeError) and 408 / 429 / 5xx are transient. A 401 is retryable only where
 * the next attempt uses a different upload URL, which B2 hands out with its
 * own token: on the same URL it would fail the same way.
 */
export function isRetryableB2Error(error: unknown, opts: { rotatesUrl?: boolean } = {}): boolean {
  if (error instanceof B2HttpError) {
    const { status } = error;
    if (status === 401) return Boolean(opts.rotatesUrl);
    return status === 408 || status === 429 || status >= 500;
  }

  return error instanceof TypeError;
}

/** Exponential backoff with full jitter, capped at `maxDelayMs`. */
export function b2RetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(B2_RETRY.maxDelayMs, B2_RETRY.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

export interface B2RetryOptions {
  /** Each attempt gets a fresh upload URL, so a 401 is worth retrying. */
  rotatesUrl?: boolean;
  /** Called before each retry; the debug logging hook. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run `attemptFn` until it resolves, a non-retryable error is thrown, or
 * `B2_RETRY.attempts` is used up. `attemptFn` gets the 1-based attempt
 * number so a caller can pick a different upload URL each time. The last
 * error is rethrown unchanged.
 */
export async function withB2Retry<T>(
  attemptFn: (attempt: number) => Promise<T>,
  opts: B2RetryOptions = {},
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptFn(attempt);
    } catch (error) {
      if (attempt >= B2_RETRY.attempts || !isRetryableB2Error(error, opts)) throw error;
      const delayMs = b2RetryDelayMs(attempt);
      opts.onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }
}

/** Throw a `B2HttpError` for a non-2xx response; return it otherwise. */
export async function assertB2Ok(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  throw new B2HttpError(`${what} failed with status ${response.status}`, response.status, body);
}
