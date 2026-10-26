import { expect } from 'chai';

import { partUploadUrlFor, validateUploadResults } from '../../src/methods.js';
import {
  B2_RETRY,
  B2HttpError,
  b2RetryDelayMs,
  isRetryableB2Error,
  withB2Retry,
} from '../../src/utils/b2-retry.js';

/**
 * Direct-to-B2 uploads used to make one attempt, so one dropped B2 request
 * failed the B2 upload; these pin the retry behaviour that replaced it.
 */
describe('B2 upload retries', () => {
  const noSleep = async () => {};
  const http = (status: number) => new B2HttpError(`failed with status ${status}`, status, '');

  describe('isRetryableB2Error', () => {
    it('retries network errors and 408 / 429 / 5xx', () => {
      expect(isRetryableB2Error(new TypeError('fetch failed'))).to.equal(true);
      for (const status of [408, 429, 500, 503]) {
        expect(isRetryableB2Error(http(status)), String(status)).to.equal(true);
      }
    });

    it('does not retry other 4xx', () => {
      for (const status of [400, 403, 404]) {
        expect(isRetryableB2Error(http(status)), String(status)).to.equal(false);
      }
    });

    it('retries a 401 only when the next attempt uses another upload URL', () => {
      expect(isRetryableB2Error(http(401))).to.equal(false);
      expect(isRetryableB2Error(http(401), { rotatesUrl: true })).to.equal(true);
    });

    it('does not retry unrelated errors', () => {
      expect(isRetryableB2Error(new Error('ENOENT'))).to.equal(false);
    });
  });

  describe('withB2Retry', () => {
    it('returns once an attempt succeeds, after transient failures', async () => {
      const seen: number[] = [];
      const result = await withB2Retry(
        async (attempt) => {
          seen.push(attempt);
          if (attempt < 3) throw http(503);
          return 'ok';
        },
        { sleep: noSleep },
      );

      expect(result).to.equal('ok');
      expect(seen).to.deep.equal([1, 2, 3]);
    });

    it('stops at the first non-retryable error', async () => {
      let calls = 0;
      const error = await withB2Retry(
        async () => {
          calls++;
          throw http(400);
        },
        { sleep: noSleep },
      ).catch((error_: unknown) => error_);

      expect(calls).to.equal(1);
      expect((error as B2HttpError).status).to.equal(400);
    });

    it('gives up after B2_RETRY.attempts and rethrows the last error', async () => {
      let calls = 0;
      const retries: number[] = [];
      const error = await withB2Retry(
        async () => {
          calls++;
          throw new TypeError('fetch failed');
        },
        { onRetry: (attempt) => retries.push(attempt), sleep: noSleep },
      ).catch((error_: unknown) => error_);

      expect(calls).to.equal(B2_RETRY.attempts);
      expect(retries).to.have.length(B2_RETRY.attempts - 1);
      expect(error).to.be.instanceOf(TypeError);
    });
  });

  it('backs off within [ceiling/2, ceiling], capped at maxDelayMs', () => {
    expect(b2RetryDelayMs(1, () => 0)).to.equal(B2_RETRY.baseDelayMs / 2);
    expect(b2RetryDelayMs(1, () => 1)).to.equal(B2_RETRY.baseDelayMs);
    expect(b2RetryDelayMs(20, () => 1)).to.equal(B2_RETRY.maxDelayMs);
  });

  it('moves each retry of a part on to the next upload URL', () => {
    const urls = ['a', 'b', 'c', 'd'];
    expect([1, 2, 3, 4, 5].map((attempt) => partUploadUrlFor(urls, 1, attempt))).to.deep.equal(['a', 'b', 'c', 'd', 'a']);
    expect([1, 2, 3].map((attempt) => partUploadUrlFor(urls, 4, attempt))).to.deep.equal(['d', 'a', 'b']);
  });

  describe('validateUploadResults', () => {
    const b2 = { strategy: 'large' };

    it('passes when either upload succeeded', () => {
      expect(() =>
        validateUploadResults({ error: new Error('sb'), success: false }, { error: null, success: true }, b2, false),
      ).not.to.throw();
    });

    it('names the Backblaze error as well as the Supabase one', () => {
      expect(() =>
        validateUploadResults(
          { error: new Error('signature verification failed'), success: false },
          { error: new Error('Part 2 upload failed with status 503'), success: false },
          b2,
          false,
        ),
      )
        .to.throw(/Backblaze error: Part 2 upload failed with status 503/)
        .and.to.match(/signature verification failed/);
    });
  });
});
