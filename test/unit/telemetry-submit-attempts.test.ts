import { expect } from 'chai';

import { telemetry } from '../../src/services/telemetry.service.js';

/**
 * How many attempts the flow submit took (dcd#1617 follow-up) rides on the
 * lifecycle event as `extra.submit_attempts`. Anything above 1 is a response
 * that was lost and a submit that was sent again, which is the number to count
 * when judging how often the API stalls under the CLI.
 */
interface SentEvent {
  extra?: Record<string, unknown>;
  message: string;
}

describe('submit attempts telemetry', () => {
  const realFetch = globalThis.fetch;
  let events: SentEvent[];

  beforeEach(function () {
    // The singleton reads this once, at import.
    if (process.env.DCD_TELEMETRY_DISABLED) this.skip();

    events = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      events.push(...(JSON.parse(String(init?.body)) as { events: SentEvent[] }).events);
      return new Response('{}', { status: 202 });
    }) as typeof fetch;
    telemetry.configure({
      apiUrl: 'http://localhost:9999',
      auth: { headers: { 'x-app-api-key': 'test-key' }, mode: 'apiKey' },
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const last = (message: string) =>
    events.filter((e) => e.message === message).pop();

  it('puts the attempt count on `command completed`', async () => {
    telemetry.recordSubmitAttempts(3);
    telemetry.recordCommandSuccess();
    await telemetry.flush();

    expect(last('command completed')?.extra?.submit_attempts).to.equal(3);
  });

  it('and on `command failed`', async () => {
    telemetry.recordSubmitAttempts(9);
    telemetry.recordCommandFailure({ error: new Error('boom'), exitCode: 1 });
    await telemetry.flush();

    expect(last('command failed')?.extra?.submit_attempts).to.equal(9);
  });
});
