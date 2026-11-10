import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect } from 'chai';

import {
  executionFlags,
  RETIRED_RUNNER_TYPES,
  RUNNER_TYPE_OPTIONS,
} from '../../src/config/flags/execution.flags.js';
import { registerRunCloudTest } from '../../src/mcp/tools/run-cloud-test.js';
import { validateEnum } from '../../src/utils/cli.js';

/**
 * gpu1 was removed on 9 November 2026 and the API runs it on cpu1. A script
 * or agent that still passes it must keep working, but nothing may offer it.
 */
describe('retired runner types', () => {
  describe('--runner-type', () => {
    it('lists only the current runner types in its help', () => {
      const help = executionFlags['runner-type'].description;
      for (const retired of RETIRED_RUNNER_TYPES) {
        expect(help).to.not.include(retired);
      }
      expect(help).to.include(`options: ${RUNNER_TYPE_OPTIONS.join(', ')}`);
    });

    it('still accepts a retired runner type', () => {
      expect(
        validateEnum('gpu1', RUNNER_TYPE_OPTIONS, 'runner-type', RETIRED_RUNNER_TYPES),
      ).to.equal('gpu1');
    });

    it('leaves retired runner types out of the error for an unknown one', () => {
      expect(() =>
        validateEnum('gpu2', RUNNER_TYPE_OPTIONS, 'runner-type', RETIRED_RUNNER_TYPES),
      ).to.throw(
        'Invalid value for --runner-type: "gpu2". Expected one of: default, m4, m1, cpu1',
      );
    });
  });

  describe('dcd_run_cloud_test runnerType', () => {
    let client: Client;

    beforeEach(async () => {
      const server = new McpServer({ name: 'test', version: '0.0.0' });
      registerRunCloudTest(server);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      client = new Client({ name: 'agent', version: '1' });
      await client.connect(a);
    });

    afterEach(async () => {
      await client.close();
    });

    it('advertises only the current runner types', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'dcd_run_cloud_test')!;
      const runnerType = tool.inputSchema.properties!.runnerType as { enum: string[] };
      expect(runnerType.enum).to.deep.equal([...RUNNER_TYPE_OPTIONS]);
    });

    // Passing both appFile and appBinaryId fails inside the handler, before
    // any network call, so reaching that error means the input validated.
    const call = (runnerType: string) =>
      client.callTool({
        arguments: { appBinaryId: 'b', appFile: 'a.apk', flowFile: 'f.yaml', runnerType },
        name: 'dcd_run_cloud_test',
      });
    const text = (result: Awaited<ReturnType<typeof call>>) =>
      (result.content as { text: string }[])[0].text;

    it('still accepts a retired runner type', async () => {
      expect(text(await call('gpu1'))).to.include('Provide only one of appFile or appBinaryId');
    });

    it('rejects an unknown runner type', async () => {
      expect(text(await call('gpu2'))).to.include('Input validation error');
    });
  });
});
