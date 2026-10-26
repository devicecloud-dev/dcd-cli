/**
 * `dcd mcp`: one stdio MCP server with two sets of tools (dcd plan 4.4).
 *
 * - The `dcd_*` cloud-test tools, from the same in-process server `dcd-mcp`
 *   runs (createServer), reached over an in-memory transport.
 * - The device tools, proxied from the hosted endpoint at `<api>/mcp`, so
 *   they are defined (and contract-tested) once, in the API. The bridge adds
 *   what a remote server can't do: `install_app` takes a local `app_path`,
 *   and `run` takes a local `path` (a flow file, or a directory uploaded as
 *   a bundle).
 *
 * Auth is the CLI's: an API key or a `dcd login` session (getContext). The
 * hosted endpoint accepts both. A session is renewed before it expires, and
 * the remote connection is remade with it.
 *
 * stdout is the JSON-RPC channel: everything else goes to stderr.
 */
import { readFile, stat } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type { AuthContext } from '../types/domain/auth.types.js';
import { uploadLocalApp } from '../utils/app-upload.js';
import { getCliVersion } from '../utils/cli.js';
import { uploadFlowBundle } from '../utils/device-bundle.js';
import { getContext, isReadOnly, logStderr } from './context.js';
import { errorResult, runTool } from './helpers.js';
import { createServer } from './server.js';

const INSTRUCTIONS =
  'DeviceCloud tools. dcd_* tools run Maestro test suites in the cloud. The device tools lease a cloud iOS or Android device for you to drive: start_device, then inspect_screen / take_screenshot, launch_app, run, and stop_device when done. Call cheat_sheet first for Maestro syntax. Local files: install_app takes app_path and run takes path (a flow file or a directory), which this server uploads for you.';

/**
 * How long one forwarded call may take. Longer than dcd_run_cloud_test's
 * longest wait (3600s) plus an upload. The MCP client calling this server
 * still applies its own timeout, and its cancel is passed through.
 */
export const CALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const READ_ONLY_INSTRUCTIONS =
  'DeviceCloud tools, read-only: nothing here starts a device, runs a test or changes anything. dcd_* tools read cloud test runs and their results. The device tools read open device sessions: list_devices, get_device_status, inspect_screen, take_screenshot, get_logs.';

/** The inputs this bridge adds to hosted tools, and what they say. */
const LOCAL_INPUTS: Record<string, { description: string; properties: Record<string, object> }> = {
  install_app: {
    description:
      ' Or pass app_path, a build on this machine (.apk, or a simulator .app / .zip / Expo .tar.gz), which is uploaded first.',
    properties: {
      app_path: {
        type: 'string',
        description: 'A build on this machine to upload and install. Pass this, app_binary_id or app_url.',
      },
    },
  },
  run: {
    description:
      ' Or pass path: a flow file on this machine (sent as yaml), or a directory of flows (uploaded as a bundle; flow picks the entry file inside it).',
    properties: {
      path: {
        type: 'string',
        description: 'A local flow file, or a directory of flows. Pass this, yaml or flow_upload_id.',
      },
    },
  },
};

/** A hosted tool with this bridge's local inputs added. */
export function withLocalInputs(tool: Tool): Tool {
  const extra = LOCAL_INPUTS[tool.name];
  if (!extra) return tool;
  return {
    ...tool,
    description: `${tool.description ?? ''}${extra.description}`,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...tool.inputSchema.properties, ...extra.properties },
    },
  };
}

/**
 * Do the local part of a call (uploads, reading a file) and return the
 * arguments the hosted tool takes.
 */
export async function resolveLocalInputs(
  name: string,
  args: Record<string, unknown>,
  ctx: { apiUrl: string; auth: AuthContext },
): Promise<Record<string, unknown>> {
  if (name === 'install_app' && typeof args.app_path === 'string') {
    const { app_path: filePath, ...rest } = args;
    logStderr(`Uploading ${filePath}…`);
    const binaryId = await uploadLocalApp({
      ...ctx,
      filePath: filePath as string,
      log: logStderr,
      showProgress: false,
    });
    return { ...rest, app_binary_id: binaryId };
  }

  if (name === 'run' && typeof args.path === 'string') {
    const { path: flowPath, ...rest } = args;
    const info = await stat(flowPath as string).catch(() => null);
    if (!info) throw new Error(`No such file or directory: ${flowPath}`);
    if (info.isDirectory()) {
      logStderr(`Uploading the flows in ${flowPath}…`);
      const bundle = await uploadFlowBundle({ ...ctx, dir: flowPath as string, log: logStderr });
      return { ...rest, flow_upload_id: bundle.id };
    }

    return { ...rest, yaml: await readFile(flowPath as string, 'utf8') };
  }

  return args;
}

/**
 * The hosted device tools, over one connection made on first use and shared
 * by every call.
 *
 * Auth goes on each request, not on the connection. Remaking the connection
 * when a session is renewed would close it under calls still running (a `run`
 * can take minutes), and they would fail with "Connection closed" while the
 * flow carried on. The hosted /mcp is stateless, so nothing ties the
 * connection to the auth it started with.
 */
class RemoteDevices {
  private connecting: Promise<Client> | null = null;
  private tools: Tool[] | null = null;

  /** Calls that arrive together share one connect. A failed one is retried by the next call. */
  connect(): Promise<Client> {
    this.connecting ??= this.open().catch((error: unknown) => {
      this.connecting = null;
      throw error;
    });
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const { apiUrl } = await getContext();
    const client = new Client({ name: 'dcd-mcp-bridge', version: getCliVersion() });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${apiUrl}/mcp`), {
        fetch: async (url, init) => {
          const { auth } = await getContext();
          const headers = new Headers(init?.headers);
          for (const [key, value] of Object.entries(auth.headers)) headers.set(key, value);
          return fetch(url, { ...init, headers });
        },
      }),
    );
    return client;
  }

  async list(): Promise<Tool[]> {
    if (this.tools) return this.tools;
    const client = await this.connect();
    const { tools } = await client.listTools();
    this.tools = tools;
    return tools;
  }

  has(name: string): boolean {
    return this.tools?.some((t) => t.name === name) ?? false;
  }

  /** Annotated read-only by the hosted server: changes nothing, costs nothing. */
  isReadOnly(name: string): boolean {
    return this.tools?.find((t) => t.name === name)?.annotations?.readOnlyHint === true;
  }
}

/**
 * Build the `dcd mcp` server. Without a reachable hosted endpoint (no
 * credentials yet, or an API without it), it still serves the dcd_* tools
 * and says why on stderr.
 */
export async function createBridgeServer(
  opts: { callTimeoutMs?: number } = {},
): Promise<Server> {
  const callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const [localClientSide, localServerSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(localServerSide);
  const local = new Client({ name: 'dcd-mcp-bridge', version: getCliVersion() });
  await local.connect(localClientSide);
  const localNames = new Set((await local.listTools()).tools.map((t) => t.name));

  const remote = new RemoteDevices();
  const readOnly = isReadOnly();

  const server = new Server(
    { name: 'devicecloud', version: getCliVersion() },
    {
      capabilities: { tools: {} },
      instructions: readOnly ? READ_ONLY_INSTRUCTIONS : INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools: localTools } = await local.listTools();
    let deviceTools: Tool[] = [];
    try {
      deviceTools = (await remote.list())
        // Read-only mode keeps only the tools that change nothing.
        .filter((t) => !readOnly || t.annotations?.readOnlyHint === true)
        .map((t) => withLocalInputs(t));
    } catch (error) {
      logStderr(
        `Device tools unavailable: ${error instanceof Error ? error.message : String(error)}. Serving the dcd_* tools only.`,
      );
    }

    return { tools: [...localTools, ...deviceTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // The client's own timeout and cancel apply, not the SDK's 60s default:
    // dcd_run_cloud_test can wait an hour, and a device run or upload is long.
    const options = { signal: extra.signal, timeout: callTimeoutMs, resetTimeoutOnProgress: true };
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (localNames.has(name)) {
      return (await local.callTool({ name, arguments: args }, undefined, options)) as CallToolResult;
    }

    return runTool(`device ${name}`, async () => {
      await remote.list();
      if (!remote.has(name)) return errorResult(`Unknown tool: ${name}`);
      // The list hides these in read-only mode; refuse them if called anyway.
      if (readOnly && !remote.isReadOnly(name)) {
        return errorResult(`${name} is not available in read-only mode.`);
      }
      const client = await remote.connect();
      const remoteArgs = await resolveLocalInputs(name, args, await getContext());
      return (await client.callTool({ name, arguments: remoteArgs }, undefined, options)) as CallToolResult;
    });
  });

  return server;
}
