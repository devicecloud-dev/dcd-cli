/**
 * Shared tool plumbing: structured results and a wrapper that records
 * telemetry and converts any thrown error into an `isError` tool result (so a
 * single failing tool never tears down the long-lived server).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { telemetry } from '../services/telemetry.service.js';

/** A tool result whose text payload is pretty-printed JSON. */
export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/** An error tool result the model can read and react to. */
export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Wrap a tool handler: emit start/success/failure telemetry, flush it
 * (fire-and-forget — the process outlives the call), and translate thrown
 * errors into an `isError` result instead of rejecting. Fields the handler
 * puts on `telemetryExtra` ride on that call's completed or failed event; it
 * is per call, since one long-lived server can run several tools at once.
 */
export async function runTool(
  name: string,
  fn: (telemetryExtra: Record<string, unknown>) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const start = Date.now();
  const telemetryExtra: Record<string, unknown> = {};
  telemetry.recordMcpToolStart(name);
  try {
    const result = await fn(telemetryExtra);
    telemetry.recordMcpToolSuccess(name, Date.now() - start, telemetryExtra);
    void telemetry.flush();
    return result;
  } catch (error) {
    telemetry.recordMcpToolFailure(name, error, Date.now() - start, telemetryExtra);
    void telemetry.flush();
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
