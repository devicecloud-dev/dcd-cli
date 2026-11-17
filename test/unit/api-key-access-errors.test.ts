import { expect } from 'chai';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ApiError, ApiGateway, isPermanentApiError } from '../../src/gateways/api-gateway.js';
import { ResultsPollingService } from '../../src/services/results-polling.service.js';
import type { AuthContext } from '../../src/types/domain/auth.types.js';
import { clearCompatibilityCache, fetchCompatibilityData } from '../../src/utils/compatibility.js';

/**
 * An API key's access can be limited when it is created (for example a key
 * that may only start test runs and read the runs it started). A call
 * outside that access is a 403 `API_KEY_SCOPE`, and a run the key didn't
 * start is a 404 `UPLOAD_NOT_FOUND`. Neither clears on retry, and neither
 * means the key is invalid.
 */

const AUTH: AuthContext = { mode: 'apiKey', headers: { 'x-app-api-key': 'k' } };

const SCOPE_BODY = {
  statusCode: 403,
  message:
    "This API key is limited to CI (run tests only) and can't reach /uploads/list. Use a key with full access for this.",
  error: 'API_KEY_SCOPE',
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const thrownBy = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a rejection');
};

describe('API key access errors', () => {
  describe('handleApiError', () => {
    it('explains a scope denial without the invalid-key advice', async () => {
      const error = await thrownBy(ApiGateway.handleApiError(reply(403, SCOPE_BODY), 'Failed to list uploads'));

      expect(error).to.be.instanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).to.equal(403);
      expect(apiError.code).to.equal('API_KEY_SCOPE');
      expect(apiError.message).to.include('limited to CI (run tests only)');
      expect(apiError.message).to.include('Settings → API keys');
      expect(apiError.message).not.to.include('revoked');
    });

    it('keeps the invalid-key advice for a key the API rejected', async () => {
      const error = (await thrownBy(
        ApiGateway.handleApiError(
          reply(403, {
            statusCode: 403,
            message: 'Invalid API key. Please check your API key and ensure it is valid for this environment.',
            error: 'Forbidden',
          }),
          'Failed to list uploads',
        ),
      )) as ApiError;

      // "Forbidden" is the HTTP reason, not one of the API's codes.
      expect(error.code).to.equal(undefined);
      expect(error.message).to.include('Troubleshooting steps');
    });

    it('carries the code of a run the key cannot see', async () => {
      const error = (await thrownBy(
        ApiGateway.handleApiError(
          reply(404, { message: 'Upload not found', error: 'UPLOAD_NOT_FOUND' }),
          'Failed to get results',
        ),
      )) as ApiError;

      expect(error.code).to.equal('UPLOAD_NOT_FOUND');
      expect(isPermanentApiError(error)).to.equal(true);
    });

    it('treats only those two codes as permanent', () => {
      expect(isPermanentApiError(new ApiError('x', 403, 'API_KEY_SCOPE'))).to.equal(true);
      expect(isPermanentApiError(new ApiError('x', 404))).to.equal(false);
      expect(isPermanentApiError(new ApiError('x', 503))).to.equal(false);
      expect(isPermanentApiError(new Error('fetch failed'))).to.equal(false);
    });
  });

  describe('dcd cloud polling', () => {
    const realGetResults = ApiGateway.getResultsForUpload;
    afterEach(() => {
      ApiGateway.getResultsForUpload = realGetResults;
    });

    for (const [label, error] of [
      ['a scope denial', new ApiError('Access denied.', 403, 'API_KEY_SCOPE')],
      ['a run the key cannot see', new ApiError('Resource not found.', 404, 'UPLOAD_NOT_FOUND')],
    ] as const) {
      it(`stops at once on ${label}, rather than retrying 30 times`, async () => {
        let polls = 0;
        ApiGateway.getResultsForUpload = (async () => {
          polls++;
          throw error;
        }) as unknown as typeof ApiGateway.getResultsForUpload;
        const service = new ResultsPollingService();
        // Would skip the backoff if it retried; it must not get that far.
        (service as unknown as { sleep: () => Promise<void> }).sleep = async () => {};

        const caught = await thrownBy(
          service.pollUntilComplete({
            auth: AUTH,
            apiUrl: 'https://api.example.com',
            consoleUrl: 'https://console.example.com/results?upload=u1',
            json: true,
            uploadId: 'u1',
          }),
        );

        expect(caught).to.equal(error);
        expect(polls).to.equal(1);
      });
    }
  });

  describe('compatibility data', () => {
    let server: http.Server;
    let baseUrl: string;

    before(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...SCOPE_BODY, message: SCOPE_BODY.message.replace('CI (run tests only)', 'device sessions') }));
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    });

    beforeEach(() => clearCompatibilityCache());

    it('says why the API refused, not only the status code', async () => {
      const error = (await thrownBy(fetchCompatibilityData(baseUrl, AUTH))) as Error;

      expect(error.message).to.include('limited to device sessions');
      expect(error.message).not.to.include('HTTP error! status: 403');
      expect(error.cause).to.be.instanceOf(ApiError);
    });
  });
});
