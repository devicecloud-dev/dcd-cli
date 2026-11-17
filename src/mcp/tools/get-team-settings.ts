import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ApiGateway } from '../../gateways/api-gateway.js';
import { getContext } from '../context.js';
import { jsonResult, runTool } from '../helpers.js';

/**
 * Read-only: the team's settings, the same object `dcd settings --json`
 * prints. Lets an agent check limits (concurrency, test runtime) before it
 * plans a run, and see how the team is set up without the console.
 */
export function registerGetTeamSettings(server: McpServer): void {
  server.registerTool(
    'dcd_get_team_settings',
    {
      title: 'Get team settings',
      description:
        "Read the devicecloud.dev team's settings. Changes nothing. " +
        'Returns: { orgId, name, restricted, concurrency: { runners, pools }, testRuntime: { defaultMinutes, extendedMinutes }, ' +
        'integrations: { webhook, slack, github }, signInRequirement, retryEscalation, overage }. ' +
        'concurrency gives each runner type\'s min/max tests at once; a pooled runner type is listed under its pool. ' +
        'extendedMinutes is null when extended runtime is off. ' +
        'When restricted is true (a standard team member), signInRequirement, retryEscalation and overage are null; owners, admins and API keys see them.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      runTool('dcd_get_team_settings', async () => {
        const { apiUrl, auth } = await getContext();
        return jsonResult(await ApiGateway.getTeamSettings(apiUrl, auth));
      }),
  );
}
