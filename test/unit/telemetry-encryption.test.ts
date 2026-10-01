import { expect } from 'chai';

import { jsonResult, runTool } from '../../src/mcp/helpers.js';
import {
  type EncryptionTelemetry,
  telemetry,
} from '../../src/services/telemetry.service.js';

/**
 * What a run encrypted, and what decided it, rides on its lifecycle event
 * (dcd#1138) as `extra.encrypt`: the API's /cli/logs proxy forwards `extra`
 * but only the `meta` fields it knows.
 */
interface SentEvent {
  extra?: Record<string, unknown>;
  message: string;
}

describe('encryption telemetry (#1138)', () => {
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

  it('puts what the command encrypted on `command completed`, merged as it happens', async () => {
    telemetry.recordEncryption({ binary: false, env: false, flow: false, source: 'server' });
    telemetry.recordEncryption({ binary: true });
    telemetry.recordEncryption({ env: true, flow: true });
    telemetry.recordCommandSuccess();
    await telemetry.flush();

    expect(last('command completed')?.extra?.encrypt).to.deep.equal({
      binary: true,
      env: true,
      flow: true,
      source: 'server',
    });
  });

  it('puts it on `command failed` too', async () => {
    telemetry.recordEncryption({ binary: false, env: false, flow: false, source: 'flag' });
    telemetry.recordCommandFailure({ error: new Error('boom'), exitCode: 1 });
    await telemetry.flush();

    expect(last('command failed')?.extra?.encrypt).to.deep.equal({
      binary: false,
      env: false,
      flow: false,
      source: 'flag',
    });
  });

  describe('MCP tools', () => {
    const encrypt: EncryptionTelemetry = {
      binary: true,
      env: false,
      flow: true,
      source: 'env',
    };

    it('sends the fields a tool adds on its `mcp tool completed` event', async () => {
      await runTool('dcd_test_tool', async (telemetryExtra) => {
        telemetryExtra.encrypt = encrypt;
        return jsonResult({});
      });
      await telemetry.flush();

      expect(last('mcp tool completed')?.extra).to.deep.include({
        encrypt,
        tool: 'dcd_test_tool',
      });
    });

    it('and on `mcp tool failed`', async () => {
      const result = await runTool('dcd_test_tool', async (telemetryExtra) => {
        telemetryExtra.encrypt = encrypt;
        throw new Error('boom');
      });
      await telemetry.flush();

      expect(result.isError).to.equal(true);
      expect(last('mcp tool failed')?.extra).to.deep.include({
        encrypt,
        error_message: 'boom',
      });
    });

    it('keeps the fields of one call off the next', async () => {
      await runTool('dcd_test_tool', async (telemetryExtra) => {
        telemetryExtra.encrypt = encrypt;
        return jsonResult({});
      });
      await runTool('dcd_other_tool', async () => jsonResult({}));
      await telemetry.flush();

      expect(last('mcp tool completed')?.extra).to.not.have.property('encrypt');
    });
  });
});
