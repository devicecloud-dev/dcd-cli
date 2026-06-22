import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { fetchCompatibilityData } from '../../utils/compatibility.js';
import { getContext } from '../context.js';
import { jsonResult, runTool } from '../helpers.js';

/**
 * Discovery tool: the matrix of devices, OS versions, and Maestro versions the
 * org can run. Agents should call this before `dcd_run_cloud_test` so they pass
 * valid `iosDevice` / `iosVersion` / `androidDevice` / `androidApiLevel` values.
 */
export function registerListDevices(server: McpServer): void {
  server.registerTool(
    'dcd_list_devices',
    {
      title: 'List available devices',
      description:
        'List the iOS and Android devices, OS versions, and Maestro versions available on devicecloud.dev. ' +
        'Use this to discover valid device/version values before submitting a test run. ' +
        'Returns: { ios, android, androidPlay, maestro }, where each platform maps OS version → supported device list.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      runTool('dcd_list_devices', async () => {
        const { apiUrl, auth } = await getContext();
        const data = await fetchCompatibilityData(apiUrl, auth);
        return jsonResult({
          ios: data.ios,
          android: data.android,
          androidPlay: data.androidPlay,
          maestro: data.maestro,
        });
      }),
  );
}
