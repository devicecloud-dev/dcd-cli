import { defineCommand } from 'citty';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBridgeServer } from '../mcp/bridge.js';
import { isReadOnly, logStderr } from '../mcp/context.js';
import { telemetry } from '../services/telemetry.service.js';

/**
 * `dcd mcp`: the MCP server over stdio, for MCP clients to launch. It serves
 * the dcd_* cloud-test tools and the device tools (see src/mcp/bridge.ts).
 * Nothing but JSON-RPC may reach stdout.
 */
export const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description: 'Run the DeviceCloud MCP server on stdio (cloud tests and cloud devices)',
    // Listed in `dcd --help` with `dcd device`, once the device API is live.
    hidden: true,
  },
  args: {
    'read-only': {
      type: 'boolean',
      default: false,
      description: 'Serve only tools that change nothing (also DCD_MCP_READONLY=1)',
    },
  },
  async run() {
    telemetry.setCommand('mcp');
    const server = await createBridgeServer();
    await server.connect(new StdioServerTransport());
    logStderr(`DeviceCloud MCP server running on stdio${isReadOnly() ? ' (read-only)' : ''}`);
  },
});
