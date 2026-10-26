import { expect } from 'chai';
import * as fs from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { createBridgeServer, resolveLocalInputs, withLocalInputs } from '../../src/mcp/bridge.js';
import { clearContextCache } from '../../src/mcp/context.js';

/**
 * A stand-in for the hosted /mcp: stateless Streamable HTTP, one server per
 * POST, as the API runs it. Records each call and the auth header it saw.
 */
function startHosted(): Promise<{
  calls: { args: unknown; auth?: string; name: string }[];
  http: HttpServer;
  inits: number;
  url: string;
}> {
  const calls: { args: unknown; auth?: string; name: string }[] = [];
  const hosted = { calls, inits: 0 };
  const http = createHttpServer(async (req, res) => {
    // Stateless, as the API: no GET stream, no session to delete.
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (body.method === 'initialize') hosted.inits++;
    const auth = req.headers['x-app-api-key'] as string | undefined;
    const server = new McpServer({ name: 'hosted', version: '1' });
    const record = (name: string) => async (args: unknown) => {
      calls.push({ name, args, auth });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: name }) }] };
    };
    server.registerTool(
      'install_app',
      {
        description: 'Install an app.',
        inputSchema: { session_id: z.string().optional(), app_binary_id: z.string().optional() },
      },
      record('install_app'),
    );
    server.registerTool(
      'run',
      { description: 'Run Maestro.', inputSchema: { yaml: z.string().optional(), flow_upload_id: z.string().optional() } },
      record('run'),
    );
    server.registerTool(
      'get_logs',
      { description: 'Slow.', inputSchema: { ms: z.number() }, annotations: { readOnlyHint: true } },
      async ({ ms }) => {
        await new Promise((r) => setTimeout(r, ms));
        return { content: [{ type: 'text' as const, text: 'late' }] };
      },
    );
    server.registerTool(
      'inspect_screen',
      { description: 'Inspect.', inputSchema: {}, annotations: { readOnlyHint: true } },
      record('inspect_screen'),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  return new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      const { port } = http.address() as AddressInfo;
      resolve(Object.assign(hosted, { http, url: `http://127.0.0.1:${port}` }));
    });
  });
}

describe('dcd mcp bridge', () => {
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_ARGV = [...process.argv];
  let hosted: Awaited<ReturnType<typeof startHosted>>;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-bridge-test-'));
    process.env.DCD_CONFIG_DIR = tempDir;
    process.env.DCD_TELEMETRY_DISABLED = '1';
    process.env.DEVICE_CLOUD_API_KEY = 'test-key';
    delete process.env.DCD_MCP_READONLY;
    hosted = await startHosted();
    process.env.DCD_API_URL = hosted.url;
    clearContextCache();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    process.argv = [...ORIGINAL_ARGV];
    clearContextCache();
    hosted.http.closeAllConnections();
    await new Promise((r) => hosted.http.close(r));
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  async function connect(callTimeoutMs?: number): Promise<Client> {
    const server = await createBridgeServer({ callTimeoutMs });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(a);
    return client;
  }

  it('serves the dcd_* tools and the hosted device tools together', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).to.include.members(['dcd_list_runs', 'dcd_run_cloud_test', 'install_app', 'run', 'inspect_screen']);
    const install = (await client.listTools()).tools.find((t) => t.name === 'install_app')!;
    expect(install.inputSchema.properties).to.have.keys('session_id', 'app_binary_id', 'app_path');
    await client.close();
  });

  it('forwards a device tool call with the CLI credentials', async () => {
    const client = await connect();
    await client.listTools();
    const result = await client.callTool({ name: 'inspect_screen', arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(hosted.calls).to.deep.equal([{ name: 'inspect_screen', args: {}, auth: 'test-key' }]);
    await client.close();
  });

  it('keeps a running call when the session is renewed, and sends the new auth', async () => {
    const client = await connect();
    await client.listTools();
    const slow = client.callTool({ name: 'get_logs', arguments: { ms: 300 } });
    await new Promise((r) => setTimeout(r, 50));
    // As if a `dcd login` session were renewed: getContext resolves new auth.
    process.env.DEVICE_CLOUD_API_KEY = 'renewed-key';
    clearContextCache();
    await client.callTool({ name: 'inspect_screen', arguments: {} });
    const result = await slow;
    expect(result.isError).to.not.equal(true);
    expect(JSON.stringify(result.content)).to.include('late');
    expect(hosted.calls).to.deep.equal([{ name: 'inspect_screen', args: {}, auth: 'renewed-key' }]);
    expect(hosted.inits).to.equal(1);
    await client.close();
  });

  it('shares one connection between calls that arrive together', async () => {
    const client = await connect();
    await Promise.all([client.listTools(), client.listTools(), client.callTool({ name: 'inspect_screen', arguments: {} })]);
    expect(hosted.inits).to.equal(1);
    await client.close();
  });

  it("applies the bridge's call timeout, not the SDK's 60s default", async () => {
    // The agent's own client allows long calls; only the bridge's limit applies.
    const client = await connect(300);
    await client.listTools();
    const opts = { timeout: 10_000 };
    const fast = await client.callTool({ name: 'get_logs', arguments: { ms: 50 } }, undefined, opts);
    expect(fast.isError).to.not.equal(true);
    const slow = await client.callTool({ name: 'get_logs', arguments: { ms: 1000 } }, undefined, opts);
    expect(slow.isError).to.equal(true);
    expect(JSON.stringify(slow.content)).to.match(/timed out/i);
    await client.close();
  });

  it('sends a local flow file as yaml', async () => {
    const flow = path.join(tempDir, 'login.yaml');
    fs.writeFileSync(flow, 'appId: x\n---\n- launchApp\n');
    const client = await connect();
    await client.listTools();
    await client.callTool({ name: 'run', arguments: { path: flow } });
    expect(hosted.calls[0]).to.deep.include({ name: 'run', args: { yaml: 'appId: x\n---\n- launchApp\n' } });
    await client.close();
  });

  it('read-only mode keeps only device tools that change nothing', async () => {
    process.env.DCD_MCP_READONLY = '1';
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).to.include('inspect_screen');
    expect(names).to.not.include.members(['install_app', 'run', 'dcd_run_cloud_test']);

    // Hidden is not enough: a call made anyway is refused, never forwarded.
    const refused = await client.callTool({ name: 'run', arguments: { yaml: 'x' } });
    expect(refused.isError).to.equal(true);
    expect(JSON.stringify(refused.content)).to.include('read-only mode');
    expect(hosted.calls).to.deep.equal([]);
    await client.callTool({ name: 'inspect_screen', arguments: {} });
    expect(hosted.calls.map((c) => c.name)).to.deep.equal(['inspect_screen']);
    await client.close();
  });

  it('still serves the dcd_* tools when the hosted endpoint is unreachable', async () => {
    process.env.DCD_API_URL = 'http://127.0.0.1:9';
    clearContextCache();
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).to.include('dcd_list_runs');
    expect(names).to.not.include('run');
    const result = await client.callTool({ name: 'run', arguments: { yaml: 'x' } });
    expect(result.isError).to.equal(true);
    await client.close();
  });

  describe('helpers', () => {
    it('withLocalInputs adds the local inputs and leaves other tools alone', () => {
      const tool = { name: 'run', description: 'Run.', inputSchema: { type: 'object' as const, properties: { yaml: {} } } };
      const patched = withLocalInputs(tool);
      expect(patched.inputSchema.properties).to.have.keys('yaml', 'path');
      expect(patched.description).to.match(/^Run\. Or pass path/);
      const other = { name: 'stop_device', inputSchema: { type: 'object' as const } };
      expect(withLocalInputs(other)).to.equal(other);
    });

    it('resolveLocalInputs leaves calls without local inputs alone, and refuses a missing path', async () => {
      const ctx = { apiUrl: 'http://x', auth: { headers: {}, mode: 'apiKey' as const } };
      expect(await resolveLocalInputs('run', { yaml: 'y' }, ctx)).to.deep.equal({ yaml: 'y' });
      try {
        await resolveLocalInputs('run', { path: path.join(tempDir, 'nope') }, ctx);
        expect.fail('should have thrown');
      } catch (error) {
        expect((error as Error).message).to.include('No such file or directory');
      }
    });
  });
});
