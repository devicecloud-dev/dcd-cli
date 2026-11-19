import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { clearContextCache } from '../../src/mcp/context.js';
import { isInside, localInput, localOutput, markWritten } from '../../src/mcp/local-files.js';
import { createServer } from '../../src/mcp/server.js';

/**
 * The files an MCP tool reads or writes for an agent stay inside the
 * working directory, and a write never replaces a file the server did not
 * write: an agent's tool call is not the user typing a path.
 */
describe('MCP local files', () => {
  const ORIGINAL_CWD = process.cwd();
  const ORIGINAL_ENV = { ...process.env };
  let root: string;
  let elsewhere: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-local-files-')));
    elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-local-elsewhere-')));
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    process.env = { ...ORIGINAL_ENV };
    clearContextCache();
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(elsewhere, { force: true, recursive: true });
  });

  it('isInside takes the folder itself and what is under it, and nothing beside it', () => {
    expect(isInside('/a/b', '/a/b')).to.equal(true);
    expect(isInside('/a/b/c.zip', '/a/b')).to.equal(true);
    expect(isInside('/a/bc', '/a/b')).to.equal(false);
    expect(isInside('/a', '/a/b')).to.equal(false);
  });

  it('localInput resolves a path inside, and refuses one outside or missing', () => {
    fs.writeFileSync(path.join(root, 'flow.yaml'), '');
    fs.writeFileSync(path.join(elsewhere, 'secret.yaml'), '');
    expect(localInput('flow.yaml', root)).to.equal(path.join(root, 'flow.yaml'));
    expect(() => localInput(path.join(elsewhere, 'secret.yaml'), root)).to.throw('outside the working directory');
    expect(() => localInput('nope.yaml', root)).to.throw('No such file or directory');
  });

  it('localOutput writes inside only, into new folders too, and never over a file it did not write', () => {
    expect(localOutput('out/new/artifacts.zip', root)).to.equal(path.join(root, 'out', 'new', 'artifacts.zip'));
    expect(() => localOutput(path.join(elsewhere, 'a.zip'), root)).to.throw('outside the working directory');
    expect(() => localOutput('../a.zip', root)).to.throw('outside the working directory');

    const existing = path.join(root, '.zshrc');
    fs.writeFileSync(existing, 'mine');
    expect(() => localOutput('.zshrc', root)).to.throw('already exists, and this server did not write it');

    // One it wrote itself may be written again.
    const report = localOutput('report.xml', root);
    fs.writeFileSync(report, '<x/>');
    markWritten(report);
    expect(localOutput('report.xml', root)).to.equal(report);
  });

  it('localOutput follows a link to its folder before the check', () => {
    fs.symlinkSync(elsewhere, path.join(root, 'out'));
    expect(() => localOutput('out/a.zip', root)).to.throw('outside the working directory');
  });

  it('dcd_download_artifacts refuses a path outside the working directory before downloading, and says it writes files', async () => {
    process.chdir(root);
    process.env.DEVICE_CLOUD_API_KEY = 'test-key';
    process.env.DCD_TELEMETRY_DISABLED = '1';
    // Nothing should be fetched: the path is refused first.
    process.env.DCD_API_URL = 'http://127.0.0.1:9';
    clearContextCache();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(b);
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(a);

    const tool = (await client.listTools()).tools.find((t) => t.name === 'dcd_download_artifacts')!;
    expect(tool.annotations?.readOnlyHint).to.equal(false);
    expect(tool.annotations?.destructiveHint).to.equal(false);

    const result = await client.callTool({
      name: 'dcd_download_artifacts',
      arguments: { uploadId: '00000000-0000-0000-0000-000000000000', artifactsPath: path.join(elsewhere, 'a.zip') },
    });
    expect(result.isError).to.equal(true);
    expect(JSON.stringify(result.content)).to.include('outside the working directory');
    expect(fs.readdirSync(elsewhere)).to.deep.equal([]);
    await client.close();
  });
});
