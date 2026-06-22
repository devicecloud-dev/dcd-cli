import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getCliVersion } from '../utils/cli';

import { isReadOnly } from './context';
import { registerDownloadArtifacts } from './tools/download-artifacts';
import { registerGetStatus } from './tools/get-status';
import { registerListDevices } from './tools/list-devices';
import { registerListRuns } from './tools/list-runs';
import { registerRunCloudTest } from './tools/run-cloud-test';

/**
 * Build the devicecloud.dev MCP server with its tool set registered. Read-only
 * tools are always present; the billable `dcd_run_cloud_test` is omitted in
 * read-only mode (`DCD_MCP_READONLY=1` or `--read-only`).
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'devicecloud',
    version: getCliVersion(),
  });

  registerListDevices(server);
  registerListRuns(server);
  registerGetStatus(server);
  registerDownloadArtifacts(server);

  if (!isReadOnly()) {
    registerRunCloudTest(server);
  }

  return server;
}
