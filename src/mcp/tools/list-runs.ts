import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ApiGateway } from '../../gateways/api-gateway';
import { getContext } from '../context';
import { jsonResult, runTool } from '../helpers';

/** List recent flow uploads for the org, with optional filters + pagination. */
export function registerListRuns(server: McpServer): void {
  server.registerTool(
    'dcd_list_runs',
    {
      title: 'List recent test runs',
      description:
        'List recent flow uploads (test runs) for your organization, most recent first. ' +
        'Supports name (with * wildcard), date range, and pagination. ' +
        'Returns: { uploads: [{ id, name, created_at, consoleUrl }], total, limit, offset }. ' +
        'Use the returned id with dcd_get_status or dcd_download_artifacts.',
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe('Filter by upload name; supports a * wildcard, e.g. "nightly-*"'),
        from: z
          .string()
          .optional()
          .describe('Only uploads created on or after this ISO 8601 date (e.g. 2024-01-01)'),
        to: z
          .string()
          .optional()
          .describe('Only uploads created on or before this ISO 8601 date'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum uploads to return (default 20)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Number of uploads to skip, for pagination (default 0)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool('dcd_list_runs', async () => {
        const { apiUrl, auth } = await getContext();
        for (const [key, value] of [
          ['from', args.from],
          ['to', args.to],
        ] as const) {
          if (value && Number.isNaN(Date.parse(value))) {
            throw new Error(
              `Invalid --${key} date "${value}". Use ISO 8601 format (e.g. 2024-01-01).`,
            );
          }
        }

        const response = await ApiGateway.listUploads(apiUrl, auth, {
          name: args.name,
          from: args.from,
          to: args.to,
          limit: args.limit ?? 20,
          offset: args.offset ?? 0,
        });
        return jsonResult(response);
      }),
  );
}
