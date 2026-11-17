import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { clearContextCache } from '../../src/mcp/context.js';
import { createServer } from '../../src/mcp/server.js';
import { OWNER_SETTINGS } from './settings-command.test.js';

const API = 'https://api.example.test';

describe('dcd_get_team_settings', () => {
  const realFetch = globalThis.fetch;
  const ORIGINAL_ENV = { ...process.env };
  let tempDir: string;
  let client: Client;
  let calls: Array<{ headers: Record<string, string>; url: string }>;

  const stubFetch = (status: number, body: unknown) => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  };

  const connect = async () => {
    const server = createServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: 'agent', version: '1' });
    await client.connect(a);
  };

  const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
    (result.content as { text: string }[])[0].text;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-team-settings-tool-'));
    process.env.DCD_CONFIG_DIR = tempDir;
    process.env.DCD_TELEMETRY_DISABLED = '1';
    process.env.DEVICE_CLOUD_API_KEY = 'k';
    process.env.DCD_API_URL = API;
    clearContextCache();
    calls = [];
  });

  afterEach(async () => {
    await client?.close();
    globalThis.fetch = realFetch;
    process.env = { ...ORIGINAL_ENV };
    clearContextCache();
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it('is a read-only tool with no inputs, present in read-only mode too', async () => {
    process.env.DCD_MCP_READONLY = '1';
    await connect();

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'dcd_get_team_settings');

    expect(tool, 'dcd_get_team_settings is registered').to.exist;
    expect(tool!.annotations?.readOnlyHint).to.equal(true);
    expect(tool!.inputSchema.properties ?? {}).to.deep.equal({});
  });

  it('returns the API response as JSON', async () => {
    stubFetch(200, OWNER_SETTINGS);
    await connect();

    const result = await client.callTool({ name: 'dcd_get_team_settings', arguments: {} });

    expect(result.isError).to.not.equal(true);
    expect(JSON.parse(text(result))).to.deep.equal(OWNER_SETTINGS);
    // runTool also flushes telemetry through fetch; only the settings call matters here.
    const settingsCalls = calls.filter((c) => c.url === `${API}/org/settings`);
    expect(settingsCalls).to.have.length(1);
    expect(settingsCalls[0].headers['x-app-api-key']).to.equal('k');
  });

  it('returns an error result the agent can read when the API predates the endpoint', async () => {
    stubFetch(404, { message: 'Cannot GET /org/settings' });
    await connect();

    const result = await client.callTool({ name: 'dcd_get_team_settings', arguments: {} });

    expect(result.isError).to.equal(true);
    expect(text(result)).to.include("doesn't support reading team settings yet");
  });
});
