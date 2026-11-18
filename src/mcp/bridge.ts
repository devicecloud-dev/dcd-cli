/**
 * `dcd mcp`: one stdio MCP server with two sets of tools (dcd plan 4.4).
 *
 * - The `dcd_*` cloud-test tools, from the same in-process server `dcd-mcp`
 *   runs (createServer), reached over an in-memory transport.
 * - The device tools, proxied from the hosted endpoint at `<api>/mcp`, so
 *   they are defined (and contract-tested) once, in the API. The bridge adds
 *   what a remote server can't do: `start_device` and `install_app` take a
 *   local `app_path`, and `run` takes a local `path` (a flow file, or a
 *   directory uploaded as a bundle), which must be inside the working
 *   directory (local-files.ts).
 *
 * Auth is the CLI's: an API key or a `dcd login` session (getContext). The
 * hosted endpoint accepts both. A session is renewed before it expires; the
 * one shared connection re-reads the auth on every request (RemoteDevices).
 *
 * stdout is the JSON-RPC channel: everything else goes to stderr.
 */
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
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

import { DeviceGateway, START_RECOVERY_WINDOW_MS } from '../gateways/device-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import { uploadLocalApp } from '../utils/app-upload.js';
import { getCliVersion } from '../utils/cli.js';
import { downloadFile } from '../utils/device-artifacts.js';
import { bundlePath, flowFileBundle, uploadFlowBundle } from '../utils/device-bundle.js';
import { getContext, isReadOnly, logStderr } from './context.js';
import { errorResult, runTool } from './helpers.js';
import { isInside, localInput, localOutput, markWritten, workingDirectory } from './local-files.js';
import { createServer } from './server.js';

// Moved to utils/device-bundle.ts, where `dcd device run` uses it too.
export { flowFileBundle } from '../utils/device-bundle.js';

/*
 * Sent at initialize, before this server knows which hosted tools the
 * account has: the hosted server only serves its tools to organizations that
 * have them. So these name only the dcd_* tools, and the hosted tools explain
 * themselves in their own descriptions.
 */
const INSTRUCTIONS =
  'DeviceCloud tools. dcd_* tools run Maestro test suites in the cloud: dcd_list_devices shows what you can test on, dcd_run_cloud_test submits flows (billable), and dcd_get_status follows a run. dcd_get_team_settings reads the team settings and limits. Any other tools describe their own use. Where a tool takes a path to a local file (an app build, a flow file or a directory), this server uploads it for you.';

/** The header the API reads a connection's name from. */
export const CLIENT_INSTANCE_HEADER = 'x-dcd-client-instance';

/**
 * This process's name for its connection to the hosted tools, the same for
 * as long as it runs: one `dcd mcp` is one agent's connection, and a
 * reconnect must not make its sessions someone else's.
 */
export const BRIDGE_INSTANCE = `dcd-mcp-${randomBytes(8).toString('hex')}`;

/**
 * How long one forwarded call may take. Longer than dcd_run_cloud_test's
 * longest wait (3600s) plus an upload. The MCP client calling this server
 * still applies its own timeout, and its cancel is passed through.
 */
export const CALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const READ_ONLY_INSTRUCTIONS =
  'DeviceCloud tools, read-only: nothing here runs a test or changes anything. dcd_* tools read cloud test runs and their results, and the team settings. Any other tools describe their own use.';

/** The inputs this bridge adds to hosted tools, and what they say. */
const LOCAL_INPUTS: Record<string, { description: string; properties: Record<string, object> }> = {
  start_device: {
    description:
      ' Or pass app_path, a build on this machine (.apk, or a simulator .app / .zip / Expo .tar.gz): it is uploaded before the session starts, so no device time is spent on the upload.',
    properties: {
      app_path: {
        type: 'string',
        description: 'A build on this machine to upload and install when the device is ready. Pass this or app_binary_id.',
      },
    },
  },
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
  take_screenshot: {
    description:
      ' With full_size, also pass path to save the PNG on this machine, inside the working directory this server runs in.',
    properties: {
      path: {
        type: 'string',
        description:
          'Where to save the full-size PNG, relative to the working directory or inside it. Only with full_size: true. Not over a file this server did not write.',
      },
    },
  },
  run: {
    description:
      ' Or pass path: a flow file (.yaml or .yml) on this machine, or a directory of flows (flow picks the entry file inside it), inside the working directory this server runs in. A file that uses other files (runFlow, runScript, addMedia and the like) is uploaded with them; one that uses none is sent as yaml. Only the flows and the files they use (scripts, media) are uploaded, not builds or anything else in the directory.',
    properties: {
      path: {
        type: 'string',
        description:
          'A flow file or a directory of flows, relative to the working directory or inside it. Pass this, yaml or flow_upload_id.',
      },
    },
  },
};

/** A flow file the device runs. */
const FLOW_FILE = /\.ya?ml$/i;

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
  root: string = workingDirectory(),
): Promise<Record<string, unknown>> {
  if ((name === 'install_app' || name === 'start_device') && typeof args.app_path === 'string') {
    const { app_path: filePath, ...rest } = args;
    if (rest.app_binary_id !== undefined || rest.app_url !== undefined) {
      throw new Error('Pass app_path or app_binary_id (or app_url), not both.');
    }

    logStderr(`Uploading ${filePath}…`);
    const binaryId = await uploadLocalApp({
      ...ctx,
      filePath: filePath as string,
      log: logStderr,
      showProgress: false,
    });
    return { ...rest, app_binary_id: binaryId };
  }

  if (name === 'take_screenshot' && args.path !== undefined) {
    // The hosted tool takes no path: the bridge saves the file
    // (saveFullScreenshot) once the link comes back.
    const { path: _saveTo, ...rest } = args;
    return rest;
  }

  if (name === 'run' && typeof args.path === 'string') {
    const { path: given, ...rest } = args;
    // Only inside the working directory: an agent's call is not the user
    // typing a path (local-files.ts).
    const flowPath = localInput(given as string, root);
    const info = await stat(flowPath);
    // The API takes forward slashes; a path typed on Windows has backslashes.
    const entry = typeof rest.flow === 'string' ? rest.flow.replaceAll('\\', '/') : undefined;
    if (info.isDirectory()) {
      logStderr(`Uploading the flows in ${flowPath}…`);
      const bundle = await uploadFlowBundle({ ...ctx, confineTo: root, dir: flowPath, entry, log: logStderr });
      return { ...rest, ...(entry !== undefined && { flow: entry }), flow_upload_id: bundle.id };
    }

    if (!FLOW_FILE.test(flowPath)) {
      throw new Error(`${given} is not a flow file: path takes a .yaml or .yml file, or a directory of flows.`);
    }

    const bundled = flowFileBundle(flowPath);
    if (bundled) {
      // The files it uses go too, so they must be inside as well.
      if (!isInside(realpathSync(bundled.dir), root)) {
        throw new Error(
          `${given} uses files outside the working directory (${root}). This server uploads only from there: start it in a folder that holds the flow and every file it uses.`,
        );
      }

      logStderr(`${given} uses other files; uploading it with them, from ${bundled.dir}…`);
      const bundle = await uploadFlowBundle({ ...ctx, ...bundled, confineTo: root, log: logStderr });
      return { ...rest, flow: bundlePath(bundled.entry), flow_upload_id: bundle.id };
    }

    return { ...rest, yaml: await readFile(flowPath, 'utf8') };
  }

  return args;
}

/**
 * Where a take_screenshot call asks for the full-size PNG to be saved, checked
 * before the call is made: inside the working directory, not over a file this
 * server did not write. Null when it asks for no file.
 */
export function screenshotTarget(args: Record<string, unknown>, root: string = workingDirectory()): null | string {
  if (args.path === undefined) return null;
  if (typeof args.path !== 'string' || args.path.trim() === '') {
    throw new Error('path is where to save the full-size PNG, a file name inside the working directory.');
  }

  if (args.full_size !== true) {
    throw new Error('path saves a full-size screenshot: pass full_size: true with it.');
  }

  return localOutput(args.path, root);
}

/**
 * Save the full-size PNG a take_screenshot call linked to, and say so in its
 * result. The link stays in the result whatever happens here: a download
 * that fails says why, and the agent can still use the link.
 */
export async function saveFullScreenshot(
  result: CallToolResult,
  target: string,
  download: (url: string, file: string) => Promise<void> = downloadFile,
): Promise<CallToolResult> {
  if (result.isError) return result;
  const note = (text: string): CallToolResult => ({ ...result, content: [...result.content, { type: 'text', text }] });
  const first = result.content.find((c) => c.type === 'text');
  let url: unknown;
  try {
    url = (JSON.parse(first && first.type === 'text' ? first.text : '{}') as { full_size?: { url?: unknown } })
      .full_size?.url;
  } catch {
    url = undefined;
  }

  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return note('Not saved: the answer had no link to a full-size screenshot.');
  }

  try {
    await download(url, target);
  } catch (error) {
    return note(
      `Not saved to ${target}: ${error instanceof Error ? error.message : String(error)}. The link above still works for an hour.`,
    );
  }

  markWritten(target);
  return note(`Saved to ${target}.`);
}

/**
 * What to tell the agent when a start_device call failed without an answer
 * (the connection dropped, or the server never replied). The request may
 * still have started a session, which is billed while it runs, and an agent
 * that just retries would end up with two. So list the open sessions started
 * in the last couple of minutes, and say to check before starting again.
 */
export async function explainFailedStart(
  message: string,
  ctx: { apiUrl: string; auth: AuthContext },
  now = Date.now(),
): Promise<string> {
  const head = `start_device failed: ${message}. The request may still have started a session, and a session is billed while it runs.`;
  const recent = await DeviceGateway.recentlyStarted(ctx.apiUrl, ctx.auth, now);
  if (recent === null) {
    return `${head} Call list_devices to check for one before you call start_device again.`;
  }

  if (recent.length === 0) {
    return `${head} No session was started in the last ${START_RECOVERY_WINDOW_MS / 60_000} minutes, so it is safe to call start_device again.`;
  }

  const listed = recent.map((s) => ({
    client_label: s.client_label,
    created_at: s.created_at,
    id: s.id,
    state: s.state,
  }));
  return `${head} Open sessions started in the last ${START_RECOVERY_WINDOW_MS / 60_000} minutes: ${JSON.stringify(listed)}. If one is yours, use it (get_device_status with wait: true until it is ready) instead of starting another. Otherwise stop it with stop_device. Check list_devices before you call start_device again.`;
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
  /** Why the last listing gave no device tools, while it did not. */
  unavailable: null | string = null;

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
    // In read-only mode, ask the hosted server for its read-only tools too, so
    // it refuses the rest as well. The filter here stays for an API without
    // the flag, which ignores it and lists every tool.
    const url = new URL(`${apiUrl}/mcp${isReadOnly() ? '?read_only=true' : ''}`);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        fetch: async (url, init) => {
          const { auth } = await getContext();
          const headers = new Headers(init?.headers);
          for (const [key, value] of Object.entries(auth.headers)) headers.set(key, value);
          // This process, by name: the sessions it starts are its own
          // (started_by.this_client), and a call that names no session takes
          // one of them, never a session another process started.
          headers.set(CLIENT_INSTANCE_HEADER, BRIDGE_INSTANCE);
          return fetch(url, { ...init, headers });
        },
      }),
    );
    return client;
  }

  /**
   * The hosted device tools. A list that came back empty is not kept, nor is
   * a failure: the next call asks again, so signing in or the organization
   * being enabled later is picked up without a restart.
   */
  async list(): Promise<Tool[]> {
    if (this.tools) return this.tools;
    try {
      const client = await this.connect();
      const { tools } = await client.listTools();
      if (tools.length === 0) {
        this.unavailable = NO_DEVICE_TOOLS;
        return tools;
      }

      this.tools = tools;
      this.unavailable = null;
      return tools;
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  has(name: string): boolean {
    return this.tools?.some((t) => t.name === name) ?? false;
  }

  /** Annotated read-only by the hosted server: changes nothing, costs nothing. */
  isReadOnly(name: string): boolean {
    return this.tools?.find((t) => t.name === name)?.annotations?.readOnlyHint === true;
  }
}

/** Why an account sees no device tools when the endpoint answered. */
const NO_DEVICE_TOOLS =
  'the hosted server offers no device tools to this account: Agent Devices may not be enabled for your organization';

/**
 * Listed in place of the device tools while they can't be loaded, so the
 * agent sees why (in its description) and can load them once that is fixed.
 */
export const LOAD_DEVICE_TOOLS = 'load_device_tools';

function loadDeviceToolsTool(reason: string): Tool {
  return {
    name: LOAD_DEVICE_TOOLS,
    description: `The device tools (start_device and the rest, for driving a cloud phone) could not be loaded: ${reason}. Once that is fixed (for example after \`dcd login\`), call this to load them.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  };
}

/**
 * Build the `dcd mcp` server. Without a reachable hosted endpoint (no
 * credentials yet, or an API without it), it still serves the dcd_* tools,
 * says why on stderr, and lists load_device_tools, which says why too.
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
      // listChanged: the device tools can arrive after the first listing.
      capabilities: { tools: { listChanged: true } },
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
    } catch {
      // remote.unavailable says why.
    }

    if (remote.unavailable) {
      logStderr(`Device tools unavailable: ${remote.unavailable}. Serving the dcd_* tools only.`);
      return { tools: [...localTools, loadDeviceToolsTool(remote.unavailable)] };
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

    if (name === LOAD_DEVICE_TOOLS) {
      return runTool(`device ${name}`, async () => {
        const tools = await remote.list().catch(() => []);
        if (tools.length === 0) {
          return errorResult(`The device tools are still unavailable: ${remote.unavailable ?? 'no answer'}.`);
        }

        await server.sendToolListChanged();
        return {
          content: [
            {
              type: 'text',
              text: `Loaded the device tools: ${tools.map((t) => t.name).join(', ')}. List the tools again to see them.`,
            },
          ],
        };
      });
    }

    return runTool(`device ${name}`, async () => {
      await remote.list().catch(() => []);
      if (remote.unavailable) {
        return errorResult(`${name} is not available: the device tools could not be loaded (${remote.unavailable}).`);
      }

      if (!remote.has(name)) {
        // In read-only mode the hosted server lists only its read-only tools,
        // so a device tool that changes something is unknown here as well.
        return errorResult(
          readOnly
            ? `Unknown tool: ${name}. In read-only mode this server offers only the tools that change nothing.`
            : `Unknown tool: ${name}`,
        );
      }

      // An API without the read-only flag lists every tool; refuse these here.
      if (readOnly && !remote.isReadOnly(name)) {
        return errorResult(`${name} is not available in read-only mode.`);
      }
      const client = await remote.connect();
      const ctx = await getContext();
      // Checked before the device is asked: a bad path is refused at once.
      const saveTo = name === 'take_screenshot' ? screenshotTarget(args) : null;
      const remoteArgs = await resolveLocalInputs(name, args, ctx);
      try {
        const result = (await client.callTool({ name, arguments: remoteArgs }, undefined, options)) as CallToolResult;
        return saveTo ? await saveFullScreenshot(result, saveTo) : result;
      } catch (error) {
        // A tool's own refusal comes back as a result. A throw means no answer
        // arrived, so for a start the session's fate is unknown.
        if (name !== 'start_device' || extra.signal.aborted) throw error;
        return errorResult(
          await explainFailedStart(error instanceof Error ? error.message : String(error), ctx),
        );
      }
    });
  });

  return server;
}
