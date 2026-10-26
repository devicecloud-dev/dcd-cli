import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CliError } from '../../src/utils/cli.js';
import {
  claudeCodeAddArgs,
  clientConfigPath,
  serverLaunch,
  shellLine,
  stableNodePath,
  vscodeAddArgs,
  writeClientConfig,
} from '../../src/utils/mcp-install.js';

describe('dcd mcp install', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-mcp-install-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  describe('serverLaunch', () => {
    it('starts the standalone binary by its own path', () => {
      expect(
        serverLaunch({ installMethod: 'binary', execPath: '/home/a/.dcd/bin/dcd', scriptPath: undefined, readOnly: true }),
      ).to.deep.equal({ args: ['mcp', '--read-only'], command: '/home/a/.dcd/bin/dcd' });
    });

    it('starts an npm install as node plus the script', () => {
      expect(
        serverLaunch({ installMethod: 'npm', execPath: '/usr/bin/node', scriptPath: '/usr/lib/dcd/dist/index.js', readOnly: false }),
      ).to.deep.equal({ args: ['/usr/lib/dcd/dist/index.js', 'mcp'], command: '/usr/bin/node' });
    });

    it('refuses a run from source or from the npx cache', () => {
      const from = (scriptPath: string) => () =>
        serverLaunch({ installMethod: 'npm', execPath: '/usr/bin/node', scriptPath, readOnly: false });
      expect(from('/repo/src/index.ts')).to.throw(CliError, /not from source/);
      expect(from('/home/a/.npm/_npx/1a2b/node_modules/@devicecloud.dev/dcd/dist/index.js')).to.throw(CliError, /npx cache/);
    });
  });

  it('stableNodePath prefers the PATH entry that is the same node', () => {
    const real = path.join(dir, 'Cellar', 'node', '26.1.0', 'bin');
    const linkDir = path.join(dir, 'bin');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(linkDir);
    fs.writeFileSync(path.join(real, 'node'), '');
    fs.symlinkSync(path.join(real, 'node'), path.join(linkDir, 'node'));

    const execPath = path.join(real, 'node');
    expect(stableNodePath(execPath, ['/nowhere', linkDir].join(path.delimiter), 'darwin')).to.equal(path.join(linkDir, 'node'));
    expect(stableNodePath(execPath, '/nowhere', 'darwin')).to.equal(execPath);
  });

  it('clientConfigPath knows the desktop clients', () => {
    expect(clientConfigPath('cursor', 'linux', '/h')).to.equal(path.join('/h', '.cursor', 'mcp.json'));
    expect(clientConfigPath('claude-desktop', 'darwin', '/h')).to.equal(
      path.join('/h', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
    expect(clientConfigPath('claude-desktop', 'win32', '/h', { APPDATA: '/ad' })).to.equal(
      path.join('/ad', 'Claude', 'claude_desktop_config.json'),
    );
    expect(clientConfigPath('claude-desktop', 'linux', '/h')).to.equal(undefined);
    expect(clientConfigPath('claude-code', 'darwin', '/h')).to.equal(undefined);
  });

  describe('writeClientConfig', () => {
    const launch = { args: ['mcp'], command: '/bin/dcd' };

    it('creates the file and its folder', () => {
      const file = path.join(dir, 'a', 'mcp.json');
      expect(writeClientConfig(file, launch)).to.deep.equal({ replaced: false });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).to.deep.equal({ mcpServers: { devicecloud: launch } });
    });

    it('keeps other servers and keys, and replaces its own entry', () => {
      const file = path.join(dir, 'mcp.json');
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { devicecloud: { command: 'old' }, other: { command: 'x' } }, theme: 'dark' }));
      expect(writeClientConfig(file, launch)).to.deep.equal({ replaced: true });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).to.deep.equal({
        mcpServers: { devicecloud: launch, other: { command: 'x' } },
        theme: 'dark',
      });
    });

    it('leaves a file that is not plain JSON untouched', () => {
      const file = path.join(dir, 'mcp.json');
      fs.writeFileSync(file, '{ // a comment\n}');
      expect(() => writeClientConfig(file, launch)).to.throw(CliError, /isn't plain JSON/);
      expect(fs.readFileSync(file, 'utf8')).to.equal('{ // a comment\n}');
    });
  });

  it('builds the claude and code commands', () => {
    const launch = { args: ['mcp', '--read-only'], command: '/Users/a b/.dcd/bin/dcd' };
    expect(claudeCodeAddArgs(launch)).to.deep.equal([
      'mcp', 'add', '--scope', 'user', 'devicecloud', '--', '/Users/a b/.dcd/bin/dcd', 'mcp', '--read-only',
    ]);
    expect(JSON.parse(vscodeAddArgs(launch)[1])).to.deep.equal({ name: 'devicecloud', ...launch });
    expect(shellLine('claude', claudeCodeAddArgs(launch))).to.equal(
      "claude mcp add --scope user devicecloud -- '/Users/a b/.dcd/bin/dcd' mcp --read-only",
    );
  });
});
