import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ApiGateway } from '../../gateways/api-gateway';
import { getContext } from '../context';
import { jsonResult, runTool } from '../helpers';

/**
 * Status of a single upload by id or name. This is the polling primitive: after
 * an async `dcd_run_cloud_test`, an agent calls this until `status` leaves
 * PENDING/QUEUED/RUNNING.
 */
export function registerGetStatus(server: McpServer): void {
  server.registerTool(
    'dcd_get_status',
    {
      title: 'Get test run status',
      description:
        'Get the status of a single upload (test run) by upload id or name. ' +
        'Provide exactly one of uploadId or name. ' +
        'Returns: { status, name, createdAt, tests: [{ name, status, durationSeconds, failReason }] }. ' +
        'Poll this after an async run until status is no longer PENDING/QUEUED/RUNNING.',
      inputSchema: {
        uploadId: z
          .string()
          .optional()
          .describe('UUID of the upload (as returned by dcd_run_cloud_test or dcd_list_runs)'),
        name: z.string().optional().describe('Name of the upload to look up'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool('dcd_get_status', async () => {
        if (args.uploadId && args.name) {
          throw new Error('Provide only one of uploadId or name, not both.');
        }
        if (!args.uploadId && !args.name) {
          throw new Error('Provide one of uploadId or name.');
        }

        const { apiUrl, auth } = await getContext();
        const status = await ApiGateway.getUploadStatus(apiUrl, auth, {
          uploadId: args.uploadId,
          name: args.name,
        });
        return jsonResult(status);
      }),
  );
}
