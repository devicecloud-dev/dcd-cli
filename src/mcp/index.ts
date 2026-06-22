#!/usr/bin/env node
/**
 * devicecloud.dev MCP server (stdio transport).
 *
 * Exposes the CLI's service layer to MCP clients (Claude, Cursor, …) as tools.
 * Auth is inherited from the CLI: `DEVICE_CLOUD_API_KEY` env or a stored
 * `dcd login` session (see src/mcp/context.ts). All diagnostics go to stderr —
 * stdout carries only JSON-RPC frames.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { telemetry } from '../services/telemetry.service';

import { isReadOnly, logStderr } from './context';
import { createServer } from './server';

async function main(): Promise<void> {
  telemetry.setCommand('mcp');
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr(
    `devicecloud.dev MCP server running on stdio${isReadOnly() ? ' (read-only)' : ''}`,
  );
}

main().catch((error) => {
  logStderr(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
