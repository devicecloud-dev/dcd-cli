import { expect } from 'chai';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ApiError, ApiGateway } from '../../src/gateways/api-gateway.js';
import { SessionRefreshError } from '../../src/gateways/cli-auth-gateway.js';
import {
  isRetryableSubmitError,
  SUBMIT_RETRY_BUDGET_MS,
  submitWithRetry,
} from '../../src/services/flow-submit.service.js';
import { CliError } from '../../src/utils/cli.js';
import type { AuthContext } from '../../src/types/domain/auth.types.js';

/**
 * Re-sending a flow submit whose outcome is unknown (dcd#1617 follow-up).
 *
 * The API answers a repeat of the same body (same upload id) with the run it
 * already created, so the CLI can send a submit again after a 502, a timeout
 * or a dropped connection without creating a second run. These go through the
 * real gateway and the real fetch to a local server, so the network-error and
 * timeout cases are the ones undici actually produces.
 */

const AUTH: AuthContext = { mode: 'apiKey', headers: { 'x-app-api-key': 'k' } };
const BODY = { id: 'upload-1', path: 'uploads/upload-1/upload-1.zip', name: 'run' };
type SubmitResponse = Awaited<ReturnType<typeof ApiGateway.submitFlowTest>>;
// Only the fields these tests look at; the gateway passes the body through.
const CREATED = {
  message: 'Test scheduled successfully.',
  results: [{ id: 41, test_file_name: 'flow.yaml', test_upload_id: 'upload-1' }],
} as unknown as SubmitResponse;

/** What the server does with each request, in order. */
type Reply = 'drop' | 'hold' | { body: unknown; status: number };

let server: http.Server;
let baseUrl: string;
let replies: Reply[];
let bodies: string[];

const submit = () => ApiGateway.submitFlowTest(baseUrl, AUTH, BODY);
const noSleep = () => Promise.resolve();

describe('flow submit: retry while the outcome is unknown', () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        bodies.push(raw);
        const reply = replies.shift() ?? { body: { message: 'no reply queued' }, status: 500 };
        if (reply === 'drop') {
          req.socket.destroy();
          return;
        }

        if (reply === 'hold') return; // never answers, like a held request

        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    replies = [];
    bodies = [];
  });

  it('sends the same body again after a 502 and returns the run', async () => {
    replies.push({ body: { message: 'upstream error' }, status: 502 }, { body: CREATED, status: 201 });
    const notices: string[] = [];

    const { attempts, response } = await submitWithRetry({
      fallback: () => Promise.reject(new Error('must not fall back')),
      onRetry: ({ attempt, reason }) => notices.push(`${attempt}:${reason}`),
      sleep: noSleep,
      submit,
    });

    expect(response).to.deep.equal(CREATED);
    expect(attempts).to.equal(2);
    expect(bodies).to.have.length(2);
    // The upload id is what makes the repeat safe, so it must not change.
    expect(bodies[1]).to.equal(bodies[0]);
    expect(notices).to.deep.equal(['2:HTTP 502']);
  });

  it('waits out a 409 while the first attempt is still creating the run', async () => {
    replies.push(
      { body: { code: 'SUBMISSION_IN_PROGRESS', message: 'still being created' }, status: 409 },
      { body: CREATED, status: 201 },
    );

    const { attempts } = await submitWithRetry({
      fallback: () => Promise.reject(new Error('must not fall back')),
      sleep: noSleep,
      submit,
    });

    expect(attempts).to.equal(2);
  });

  it('sends again after a dropped connection', async () => {
    replies.push('drop', { body: CREATED, status: 201 });

    const { attempts, response } = await submitWithRetry({
      fallback: () => Promise.reject(new Error('must not fall back')),
      sleep: noSleep,
      submit,
    });

    expect(response).to.deep.equal(CREATED);
    expect(attempts).to.equal(2);
  });

  it('abandons an attempt with no response and sends again', async () => {
    const original = ApiGateway.submitAttemptTimeoutMs;
    ApiGateway.submitAttemptTimeoutMs = 200;
    replies.push('hold', { body: CREATED, status: 201 });
    try {
      const reasons: string[] = [];
      const { attempts } = await submitWithRetry({
        fallback: () => Promise.reject(new Error('must not fall back')),
        onRetry: ({ reason }) => reasons.push(reason),
        sleep: noSleep,
        submit,
      });

      expect(attempts).to.equal(2);
      expect(reasons).to.deep.equal(['no response in time']);
    } finally {
      ApiGateway.submitAttemptTimeoutMs = original;
      server.closeAllConnections();
    }
  });

  it('does not send again when the API refused the request (400)', async () => {
    replies.push({ body: { message: 'bad flows' }, status: 400 });

    const error = await submitWithRetry({
      fallback: () => Promise.reject(new Error('must not fall back')),
      sleep: noSleep,
      submit,
    }).catch((error_: unknown) => error_);

    expect(error).to.be.instanceOf(ApiError);
    expect((error as ApiError).status).to.equal(400);
    expect(bodies).to.have.length(1);
  });

  it('falls back to multipart only when the first attempt finds no endpoint', async () => {
    replies.push({ body: { message: 'Cannot POST' }, status: 404 });

    const { attempts, response } = await submitWithRetry({
      fallback: (error) => Promise.resolve({ ...CREATED, message: `multipart after ${error.status}` }),
      sleep: noSleep,
      submit,
    });

    expect(attempts).to.equal(1);
    expect(response.message).to.equal('multipart after 404');
  });

  it('never falls back after a retry: that API already took an attempt', async () => {
    replies.push({ body: { message: 'upstream error' }, status: 502 }, { body: { message: 'Cannot POST' }, status: 404 });
    let fellBack = false;

    const error = await submitWithRetry({
      fallback: () => {
        fellBack = true;
        return Promise.resolve(CREATED);
      },
      sleep: noSleep,
      submit,
    }).catch((error_: unknown) => error_);

    expect(fellBack).to.equal(false);
    expect((error as ApiError).status).to.equal(404);
  });

  it('gives up with the last error once the attempts run out', async () => {
    replies.push(
      { body: { message: 'upstream error' }, status: 503 },
      { body: { message: 'upstream error' }, status: 503 },
      { body: { message: 'upstream error' }, status: 503 },
    );

    const error = await submitWithRetry({
      delaysMs: [0, 0],
      fallback: () => Promise.reject(new Error('must not fall back')),
      sleep: noSleep,
      submit,
    }).catch((error_: unknown) => error_);

    expect((error as ApiError).status).to.equal(503);
    expect(bodies).to.have.length(3);
  });

  it('waits the given delays between attempts', async () => {
    replies.push(
      { body: {}, status: 502 },
      { body: {}, status: 502 },
      { body: CREATED, status: 201 },
    );
    const slept: number[] = [];

    await submitWithRetry({
      delaysMs: [2000, 5000],
      fallback: () => Promise.reject(new Error('must not fall back')),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      submit,
    });

    expect(slept).to.deep.equal([2000, 5000]);
  });

  it('reports each attempt before it is sent, so a failure carries the count too', async () => {
    replies.push({ body: {}, status: 502 }, { body: { message: 'bad' }, status: 400 });
    const seen: number[] = [];

    await submitWithRetry({
      fallback: () => Promise.reject(new Error('must not fall back')),
      onAttempt: (attempt) => seen.push(attempt),
      sleep: noSleep,
      submit,
    }).catch(() => undefined);

    expect(seen).to.deep.equal([1, 2]);
  });

  it('starts no attempt after the time budget is spent', async () => {
    // Every attempt "takes" 60s of fake time; the budget allows two waits.
    let clock = 0;
    let calls = 0;
    const error = await submitWithRetry({
      budgetMs: 150_000,
      delaysMs: [1000, 1000, 1000, 1000],
      fallback: () => Promise.reject(new Error('must not fall back')),
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      submit() {
        calls += 1;
        clock += 60_000;
        return Promise.reject(new ApiError('upstream error', 502));
      },
    }).catch((error_: unknown) => error_);

    expect((error as ApiError).status).to.equal(502);
    // Attempts start at 0s, 61s and 122s; a fourth would start at 183s.
    expect(calls).to.equal(3);
  });

  it('keeps the worst case to minutes, not a quarter of an hour', () => {
    // The last attempt starts inside the budget and is cut by its own timeout.
    const worstCaseMs = SUBMIT_RETRY_BUDGET_MS + ApiGateway.submitAttemptTimeoutMs;
    expect(worstCaseMs).to.be.at.most(7 * 60_000);
  });

  it('does not send again when the session cannot be refreshed', async () => {
    for (const refusal of [
      new SessionRefreshError('refresh token revoked', true),
      new CliError('No stored session. Run `dcd login`.'),
    ]) {
      let calls = 0;
      const error = await submitWithRetry({
        fallback: () => Promise.reject(new Error('must not fall back')),
        sleep: noSleep,
        submit() {
          calls += 1;
          return Promise.reject(refusal);
        },
      }).catch((error_: unknown) => error_);

      expect(error).to.equal(refusal);
      expect(calls).to.equal(1);
    }
  });

  describe('isRetryableSubmitError', () => {
    for (const status of [409, 500, 502, 503, 504]) {
      it(`retries HTTP ${status}`, () => {
        expect(isRetryableSubmitError(new ApiError('x', status))).to.equal(true);
      });
    }

    for (const status of [400, 401, 402, 403, 404, 429]) {
      it(`does not retry HTTP ${status}`, () => {
        expect(isRetryableSubmitError(new ApiError('x', status))).to.equal(false);
      });
    }

    it('retries anything that is not an API answer (network, timeout, a body cut off)', () => {
      expect(isRetryableSubmitError(new TypeError('terminated'))).to.equal(true);
      expect(isRetryableSubmitError(new Error('ECONNRESET'))).to.equal(true);
    });
  });
});
