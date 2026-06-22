/**
 * Per-process MCP context: a single resolved AuthContext + API URL, plus the
 * stderr logger every tool must use.
 *
 * stdio transport reserves **stdout** for the JSON-RPC frame stream — anything
 * a tool prints there corrupts the protocol. Tools therefore call the services
 * with `logStderr` (never the `utils/cli` `logger`, which writes to stdout and
 * can `process.exit`).
 */
import type { AuthContext } from '../types/domain/auth.types.js';
import { resolveAuth } from '../utils/auth.js';
import { resolveApiUrl } from '../utils/config-store.js';

/** Write a line to stderr. Safe under stdio transport; stdout is reserved. */
export function logStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface McpContext {
  apiUrl: string;
  auth: AuthContext;
}

let cached: McpContext | null = null;

/**
 * Resolve auth + API URL once per process, lazily on first tool invocation.
 *
 * Lazy so `initialize` / `tools/list` succeed before the user has supplied a
 * credential (clients enumerate tools on connect), and so an auth failure
 * surfaces as a tool error rather than crashing the server at boot.
 *
 * Precedence matches the CLI: `DEVICE_CLOUD_API_KEY` env > stored `dcd login`
 * session. The API URL honors `DCD_API_URL` (handy for pointing the server at
 * dev/staging), then the logged-in env, then the prod default.
 */
export async function getContext(): Promise<McpContext> {
  if (cached) return cached;
  const auth = await resolveAuth({ apiKeyFlag: undefined });
  const apiUrl = resolveApiUrl(process.env.DCD_API_URL);
  cached = { apiUrl, auth };
  return cached;
}

/**
 * Read-only mode hides the only state-changing / billable tool
 * (`dcd_run_cloud_test`). Recommended for autonomous or untrusted agents.
 */
export function isReadOnly(): boolean {
  return (
    process.env.DCD_MCP_READONLY === '1' || process.argv.includes('--read-only')
  );
}
