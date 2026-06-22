/**
 * MCP server integration tests.
 *
 * Spawns the built stdio server (dist/mcp/index.js) and drives it with the real
 * MCP client over a JSON-RPC stdio transport, against the same mock API the CLI
 * suites use. A successful tool round-trip also proves stdout stays clean: the
 * client decodes newline-delimited JSON-RPC frames, so any stray stdout write
 * from a tool would corrupt framing and fail the call.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect } from 'chai';
import * as path from 'node:path';

import { MOCK_API_KEY, MOCK_API_URL } from './helpers.js';

const MCP_BIN = path.resolve('dist/mcp/index.js');

function connect(extraArgs: string[] = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN, ...extraArgs],
    env: {
      ...process.env,
      DEVICE_CLOUD_API_KEY: MOCK_API_KEY,
      DCD_API_URL: MOCK_API_URL,
      DCD_TELEMETRY_DISABLED: '1',
    },
  });
  const client = new Client({ name: 'dcd-mcp-test', version: '1.0.0' });
  return { client, ready: client.connect(transport) };
}

/** Parse the JSON text payload of a tool result. */
function parseResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  expect(result.isError, 'tool returned isError').to.not.equal(true);
  const block = result.content.find((c) => c.type === 'text');
  expect(block, 'no text content block').to.exist;
  return JSON.parse(block!.text as string);
}

describe('MCP Server Integration Tests', () => {
  describe('tool discovery', () => {
    it('lists all five tools by default', async () => {
      const { client, ready } = connect();
      await ready;
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).to.deep.equal([
          'dcd_download_artifacts',
          'dcd_get_status',
          'dcd_list_devices',
          'dcd_list_runs',
          'dcd_run_cloud_test',
        ]);
      } finally {
        await client.close();
      }
    });

    it('hides the billable run tool in read-only mode', async () => {
      const { client, ready } = connect(['--read-only']);
      await ready;
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        expect(names).to.not.include('dcd_run_cloud_test');
        expect(names).to.include('dcd_list_runs');
      } finally {
        await client.close();
      }
    });

    it('marks the run tool as non-read-only / destructive', async () => {
      const { client, ready } = connect();
      await ready;
      try {
        const { tools } = await client.listTools();
        const run = tools.find((t) => t.name === 'dcd_run_cloud_test');
        expect(run?.annotations?.readOnlyHint).to.equal(false);
        expect(run?.annotations?.destructiveHint).to.equal(true);
      } finally {
        await client.close();
      }
    });
  });

  describe('read-only tools against the mock API', () => {
    it('dcd_list_runs returns the upload list', async () => {
      const { client, ready } = connect();
      await ready;
      try {
        const result = await client.callTool({ name: 'dcd_list_runs', arguments: {} });
        const data = parseResult(result as Parameters<typeof parseResult>[0]);
        expect(data).to.have.property('uploads').that.is.an('array');
        expect(data).to.have.property('total');
        expect(data).to.have.property('limit');
      } finally {
        await client.close();
      }
    });

    it('dcd_get_status returns a status for an upload id', async () => {
      const { client, ready } = connect();
      await ready;
      try {
        const result = await client.callTool({
          name: 'dcd_get_status',
          arguments: { uploadId: 'a3f1c2e4-0000-4000-8000-000000000000' },
        });
        const data = parseResult(result as Parameters<typeof parseResult>[0]);
        expect(data).to.have.property('status');
        expect(data).to.have.property('tests').that.is.an('array');
      } finally {
        await client.close();
      }
    });

    it('surfaces a validation error as an isError result, not a crash', async () => {
      const { client, ready } = connect();
      await ready;
      try {
        const result = (await client.callTool({
          name: 'dcd_get_status',
          arguments: { uploadId: 'x', name: 'y' },
        })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
        expect(result.isError).to.equal(true);
        const text = result.content.find((c) => c.type === 'text')?.text ?? '';
        expect(text).to.match(/only one of uploadId or name/i);
      } finally {
        await client.close();
      }
    });
  });
});
