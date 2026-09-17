import { expect } from 'chai';

import {
  isSupersededRow,
  ResultsPollingService,
  supersedingConsoleUrl,
  supersedingUploadId,
} from '../../src/services/results-polling.service.js';

// A superseded run is one `dcd cloud --cancel-previous` replaced: a newer run
// of the same CI context cancelled its queued tests. The verdict below is what
// decides whether that older CI job exits 0 or fails the build, so it is worth
// pinning down separately from the polling loop around it.
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  test_file_name: 'flow.yaml',
  status: 'PASSED',
  retry_of: null,
  created_at: '2026-09-17T10:00:00.000Z',
  duration_seconds: 1,
  fail_reason: null,
  simulator_name: 'pixel-7',
  ...overrides,
});

const cancelledBySupersede = (id: number) =>
  row({
    id,
    status: 'CANCELLED',
    cancellation_reason: 'superseded_by:newer-upload',
  });

// buildPollingResult is private; it is the whole point of this file, so reach
// it rather than re-implementing the verdict in the test.
const verdict = (results: unknown[]) =>
  (
    new ResultsPollingService() as unknown as {
      buildPollingResult: (
        r: unknown[],
        uploadId: string,
        consoleUrl: string,
      ) => { status: string };
    }
  ).buildPollingResult(results, 'upload-1', 'https://console/upload-1').status;

describe('superseded runs', () => {
  describe('isSupersededRow', () => {
    it('matches only the superseded token', () => {
      expect(isSupersededRow(cancelledBySupersede(1))).to.equal(true);
      expect(isSupersededRow(row({ status: 'CANCELLED' }))).to.equal(false);
      expect(
        isSupersededRow(row({ cancellation_reason: 'user' })),
      ).to.equal(false);
      expect(isSupersededRow(row())).to.equal(false);
      expect(isSupersededRow(null)).to.equal(false);
    });
  });

  describe('supersedingUploadId', () => {
    it('reads the newer upload id out of the reason', () => {
      expect(supersedingUploadId([row(), cancelledBySupersede(2)])).to.equal(
        'newer-upload',
      );
    });

    it('is undefined when nothing was superseded', () => {
      expect(supersedingUploadId([row()])).to.equal(undefined);
    });
  });

  describe('supersedingConsoleUrl', () => {
    const base = 'https://dev.console.devicecloud.dev/results?upload=A&result=44376';

    it('points at the newer upload and drops the old result id', () => {
      // 44376 is a result of upload A; carried over it would deep-link B to a
      // test that is not in it.
      expect(supersedingConsoleUrl(base, 'A', 'B')).to.equal(
        'https://dev.console.devicecloud.dev/results?upload=B',
      );
    });

    it('handles a url with no result param', () => {
      expect(
        supersedingConsoleUrl('https://c/results?upload=A', 'A', 'B'),
      ).to.equal('https://c/results?upload=B');
    });

    it('handles result appearing first', () => {
      expect(
        supersedingConsoleUrl('https://c/results?result=1&upload=A', 'A', 'B'),
      ).to.equal('https://c/results?upload=B');
    });
  });

  describe('the run verdict', () => {
    it('is PASSED when every test passed', () => {
      expect(verdict([row(), row({ id: 2 })])).to.equal('PASSED');
    });

    it('is FAILED for an ordinary cancel, as before', () => {
      // No reason on the row: someone cancelled this run by hand, and the
      // build should still go red.
      expect(verdict([row(), row({ id: 2, status: 'CANCELLED' })])).to.equal(
        'FAILED',
      );
    });

    it('is SUPERSEDED when a newer run replaced this one', () => {
      expect(verdict([row(), cancelledBySupersede(2)])).to.equal('SUPERSEDED');
    });

    it('is SUPERSEDED even when a test had already genuinely failed', () => {
      // This run no longer speaks for the commit — the newer one does — so it
      // must not fail the build. The failure is still reported in tests[].
      const results = [
        row({ id: 1, status: 'FAILED', fail_reason: 'assertion failed' }),
        cancelledBySupersede(2),
      ];

      expect(verdict(results)).to.equal('SUPERSEDED');
    });

    it('is unchanged when every test finished before the newer run arrived', () => {
      // Nothing was still queued, so nothing was cancelled and no marker was
      // written: the verdict is whatever it would have been.
      expect(
        verdict([row(), row({ id: 2, status: 'FAILED' })]),
      ).to.equal('FAILED');
    });
  });
});
