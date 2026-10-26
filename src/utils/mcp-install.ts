/**
 * What `dcd mcp install` writes: how an MCP client starts this dcd, and the
 * config entry each client wants.
 *
 * Desktop apps (Claude Desktop, Cursor) are usually started from the Dock or
 * Start menu, so they don't read the shell rc that put dcd on PATH. Every
 * entry therefore names this dcd by its full path, never a bare `dcd`.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CliError, type InstallMethod } from './cli.js';

/** The server's name in every client's config. */
export const SERVER_NAME = 'devicecloud';

export const MCP_CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'vscode'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export const CLIENT_LABELS: Record<McpClient, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
};

export interface ServerLaunch {
  command: string;
  args: string[];
}

/**
 * The command that starts `dcd mcp` from this install. The standalone binary
 * is one file. An npm install is node plus the CLI's script; both are named
 * by full path, so a different node on PATH, or none, doesn't matter.
 */
export function serverLaunch(opts: {
  installMethod: InstallMethod;
  execPath: string;
  scriptPath: string | undefined;
  readOnly: boolean;
}): ServerLaunch {
  const tail = ['mcp', ...(opts.readOnly ? ['--read-only'] : [])];
  if (opts.installMethod === 'binary') return { command: opts.execPath, args: tail };

  if (!opts.scriptPath || /\.[cm]?ts$/.test(opts.scriptPath)) {
    throw new CliError(
      'Run `dcd mcp install` from an installed dcd, not from source: the config it writes must start a built dcd.',
    );
  }

  if (opts.scriptPath.split(/[/\\]/).includes('_npx')) {
    throw new CliError(
      'This dcd runs from the npx cache, which gets cleared, so a config pointing at it would stop working. Install dcd (curl -fsSL https://get.devicecloud.dev/install.sh | sh, or npm install -g @devicecloud.dev/dcd), then run `dcd mcp install`.',
    );
  }

  return { command: opts.execPath, args: [opts.scriptPath, ...tail] };
}

/**
 * The `node` on PATH that is this same node, else `execPath`. execPath is
 * the resolved file, which can be a versioned folder (Homebrew's Cellar) that
 * an upgrade removes; the PATH entry (/opt/homebrew/bin/node) survives it.
 */
export function stableNodePath(
  execPath: string,
  pathEnv: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): string {
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  let target: string;
  try {
    target = realpathSync(execPath);
  } catch {
    return execPath;
  }

  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try {
      if (realpathSync(candidate) === target) return candidate;
    } catch {
      // not there
    }
  }

  return execPath;
}

/**
 * The JSON config file a client reads, or undefined when it is configured
 * through its own CLI (Claude Code, VS Code) or has no known location here.
 */
export function clientConfigPath(
  client: McpClient,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (client === 'cursor') return path.join(home, '.cursor', 'mcp.json');
  if (client !== 'claude-desktop') return undefined;
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }

  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }

  return undefined;
}

/** The `mcpServers` block Claude Desktop and Cursor read, with ours in it. */
export function mcpServersSnippet(launch: ServerLaunch): { mcpServers: Record<string, ServerLaunch> } {
  return { mcpServers: { [SERVER_NAME]: launch } };
}

/**
 * Add our entry to a client's JSON config and write it back, keeping every
 * other key. Returns whether an entry was already there (and is replaced).
 * A file that isn't plain JSON (comments, say) is left alone.
 */
export function writeClientConfig(file: string, launch: ServerLaunch): { replaced: boolean } {
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.trim()) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        config = parsed as Record<string, unknown>;
      } catch {
        throw new CliError(
          `${file} isn't plain JSON, so it was left as it is. Add this to it by hand:\n${JSON.stringify(mcpServersSnippet(launch), null, 2)}`,
        );
      }
    }
  }

  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  const replaced = SERVER_NAME in servers;
  config.mcpServers = { ...servers, [SERVER_NAME]: launch };

  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, file);
  return { replaced };
}

/** `claude mcp add` arguments, at user scope so it works in every project. */
export function claudeCodeAddArgs(launch: ServerLaunch): string[] {
  return ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', launch.command, ...launch.args];
}

/** `code --add-mcp` arguments, which add the server to the VS Code user profile. */
export function vscodeAddArgs(launch: ServerLaunch): string[] {
  return ['--add-mcp', JSON.stringify({ name: SERVER_NAME, ...launch })];
}

/** A command line to show a person, quoting the parts that need it. */
export function shellLine(command: string, args: string[]): string {
  return [command, ...args].map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", String.raw`'\''`)}'`)).join(' ');
}
