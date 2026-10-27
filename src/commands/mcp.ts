import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import * as p from '@clack/prompts';
import { defineCommand } from 'citty';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { jsonFlag } from '../config/flags/output.flags.js';
import { createBridgeServer } from '../mcp/bridge.js';
import { isReadOnly, logStderr } from '../mcp/context.js';
import { telemetry } from '../services/telemetry.service.js';
import { apiKeyOverride } from '../utils/auth.js';
import { canPrompt } from '../utils/ci.js';
import { CliError, getInstallMethod, logger } from '../utils/cli.js';
import { readConfig } from '../utils/config-store.js';
import {
  CLIENT_LABELS,
  claudeCodeAddArgs,
  clientConfigPath,
  MCP_CLIENTS,
  type McpClient,
  mcpServersSnippet,
  SERVER_NAME,
  serverLaunch,
  type ServerLaunch,
  shellLine,
  stableNodePath,
  vscodeAddArgs,
  writeClientConfig,
} from '../utils/mcp-install.js';
import { colors } from '../utils/styling.js';
import { type Field, ui } from '../utils/ui.js';

const RELOAD_HINT: Record<McpClient, string> = {
  'claude-code': 'Start a new Claude Code session to load it.',
  'claude-desktop': 'Restart Claude Desktop to load it.',
  cursor: 'Restart Cursor, or reload its MCP servers, to load it.',
  vscode: 'VS Code asks you to trust the server the first time it starts.',
};

/** Run another tool's CLI without a shell. Undefined when it isn't installed. */
function runTool(command: string, args: string[]): { ok: boolean; output: string } | undefined {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

async function pickClient(value: string | undefined): Promise<McpClient> {
  if (value) {
    if ((MCP_CLIENTS as readonly string[]).includes(value)) return value as McpClient;
    throw new CliError(`Unknown client "${value}". Pick one of: ${MCP_CLIENTS.join(', ')}.`);
  }

  if (!canPrompt()) {
    throw new CliError(`Say which client to set up: dcd mcp install <${MCP_CLIENTS.join('|')}>.`);
  }

  const picked = await p.select({
    message: 'Which AI tool should use DeviceCloud?',
    options: MCP_CLIENTS.map((c) => ({ value: c, label: CLIENT_LABELS[c] })),
  });
  if (p.isCancel(picked)) throw new CliError('Cancelled.');
  return picked;
}

interface InstallResult {
  /** The file written, or the command run, to add the server. */
  target: string;
  replaced: boolean;
}

/** Add the server to `client`, through its CLI or its JSON config file. */
function install(client: McpClient, launch: ServerLaunch): InstallResult {
  if (client === 'claude-code') {
    const add = claudeCodeAddArgs(launch);
    const removed = runTool('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    if (!removed) {
      throw new CliError(`The claude command isn't on PATH. Run this where it is:\n  ${shellLine('claude', add)}`);
    }

    const added = runTool('claude', add)!;
    if (!added.ok) throw new CliError(`claude mcp add failed: ${added.output}`);
    return { target: shellLine('claude', add), replaced: removed.ok };
  }

  if (client === 'vscode') {
    const add = vscodeAddArgs(launch);
    const added = runTool('code', add);
    if (!added) {
      throw new CliError(
        `The code command isn't on PATH (in VS Code: "Shell Command: Install 'code' command in PATH"). Or run:\n  ${shellLine('code', add)}`,
      );
    }

    if (!added.ok) throw new CliError(`code --add-mcp failed: ${added.output}`);
    return { target: shellLine('code', add), replaced: false };
  }

  const file = clientConfigPath(client);
  if (!file) {
    throw new CliError(
      `${CLIENT_LABELS[client]} has no known config file on ${process.platform}. Add this to it by hand:\n${JSON.stringify(mcpServersSnippet(launch), null, 2)}`,
    );
  }

  return { target: file, ...writeClientConfig(file, launch) };
}

/** What `--print` shows: the command to run, or the file and the entry for it. */
function preview(client: McpClient, launch: ServerLaunch): { target: string; text: string } {
  if (client === 'claude-code') return { target: 'command', text: shellLine('claude', claudeCodeAddArgs(launch)) };
  if (client === 'vscode') return { target: 'command', text: shellLine('code', vscodeAddArgs(launch)) };
  return {
    target: clientConfigPath(client) ?? 'your MCP config file',
    text: JSON.stringify(mcpServersSnippet(launch), null, 2),
  };
}

const installSub = defineCommand({
  meta: {
    name: 'install',
    description: 'Add the DeviceCloud MCP server to Claude Code, Claude Desktop, Cursor or VS Code',
  },
  args: {
    client: {
      type: 'positional',
      required: false,
      description: `One of ${MCP_CLIENTS.join(', ')}. Asked when left out.`,
    },
    'read-only': {
      type: 'boolean',
      default: false,
      description: 'Have the server offer only tools that change nothing',
    },
    print: {
      type: 'boolean',
      default: false,
      description: 'Show what would be added, and change nothing',
    },
    json: jsonFlag,
  },
  async run({ args }) {
    telemetry.setCommand('mcp install');
    const client = await pickClient(args.client as string | undefined);
    const installMethod = getInstallMethod();
    const launch = serverLaunch({
      installMethod,
      execPath: installMethod === 'binary' ? process.execPath : stableNodePath(process.execPath),
      // As started, not resolved: a global npm install's bin link keeps
      // working across `npm install -g` upgrades.
      scriptPath: process.argv[1] ? path.resolve(process.argv[1]) : undefined,
      readOnly: Boolean(args['read-only']),
    });

    if (args.print) {
      const shown = preview(client, launch);
      if (args.json) {
        logger.json({ status: 'SUCCESS', client, launch, target: shown.target, text: shown.text, written: false });
        return;
      }

      logger.log(ui.section(`${CLIENT_LABELS[client]} config`));
      logger.log(ui.branch(ui.fields([['add to', shown.target]])));
      logger.log(shown.text);
      return;
    }

    const result = install(client, launch);
    const signedIn = Boolean(readConfig()?.session) || Boolean(apiKeyOverride());
    if (args.json) {
      logger.json({ status: 'SUCCESS', client, launch, target: result.target, replaced: result.replaced, written: true, signedIn });
      return;
    }

    logger.log(
      ui.success(`${result.replaced ? 'Updated' : 'Added'} DeviceCloud in ${CLIENT_LABELS[client]}`),
    );
    const rows: Field[] = [
      [client === 'claude-code' || client === 'vscode' ? 'ran' : 'wrote', result.target],
      ['starts', colors.highlight(shellLine(launch.command, launch.args))],
    ];
    logger.log(ui.branch(ui.fields(rows)));
    logger.log(ui.info(RELOAD_HINT[client]));
    if (!signedIn) {
      logger.log(
        ui.warn(`Not signed in. Run ${colors.highlight('dcd login')} so the server can use your account.`),
      );
    }
  },
});

/**
 * `dcd mcp`: the MCP server over stdio, for MCP clients to launch. It serves
 * the dcd_* cloud-test tools and the device tools (see src/mcp/bridge.ts).
 * Nothing but JSON-RPC may reach stdout. `dcd mcp install` adds it to a
 * client's config.
 */
export const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description: 'MCP server for AI agents, started by your MCP client (Claude, Cursor, VS Code)',
  },
  args: {
    'read-only': {
      type: 'boolean',
      default: false,
      description: 'Serve only tools that change nothing (also DCD_MCP_READONLY=1)',
    },
  },
  subCommands: { install: installSub },
  async run({ rawArgs }) {
    // citty runs this after a subcommand too; `dcd mcp install` must not
    // then start a server.
    if (rawArgs.some((arg) => !arg.startsWith('-'))) return;
    telemetry.setCommand('mcp');
    const server = await createBridgeServer();
    await server.connect(new StdioServerTransport());
    logStderr(`DeviceCloud MCP server running on stdio${isReadOnly() ? ' (read-only)' : ''}`);
  },
});
