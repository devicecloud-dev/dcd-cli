/**
 * How to start another tool's CLI (`code`, `claude`) without a shell.
 *
 * On Windows these are often batch files (`code.cmd`, and npm's `claude.cmd`
 * shim). Node's spawn searches PATH only for .com and .exe, and refuses to
 * start a .cmd or .bat at all without a shell (CVE-2024-27980). So we find the
 * file ourselves and, for a batch file, run it through cmd.exe with every
 * argument escaped for cmd. This doesn't lean on how Node or Bun resolve
 * commands, so the npm install and the standalone binary behave the same.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { CliError } from './cli.js';

export interface ToolSpawn {
  command: string;
  args: string[];
  /** Pass the arguments to cmd.exe as written, already quoted. */
  windowsVerbatimArguments?: boolean;
}

/** Characters cmd.exe treats specially, each escaped with a caret. */
const CMD_META = /([ !"%&()*,;<>?[\]^`|])/g;

/**
 * What to spawn for `command args`, or undefined when Windows has no such
 * command on PATH. Elsewhere the command is spawned as given, and a missing
 * one shows up as ENOENT.
 */
export function toolSpawn(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
): ToolSpawn | undefined {
  if (platform !== 'win32') return { command, args };

  const file = findOnWindowsPath(command, env, exists);
  if (!file) return undefined;
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args };
  // A line break ends cmd's line, and no escaping can stop that.
  if (args.some((arg) => /[\0\n\r]/.test(arg))) {
    throw new CliError(`Can't pass a line break to ${path.win32.basename(file)} through cmd.exe.`);
  }

  // /s strips the outer quotes and runs the rest as one line.
  const line = [file.replace(CMD_META, '^$1'), ...args.map((arg) => cmdArgument(arg))].join(' ');
  return {
    command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** The file Windows would run for `command`: each PATH folder, each PATHEXT extension. */
export function findOnWindowsPath(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean,
): string | undefined {
  const exts = (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const hasExt = exts.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
  const names = hasExt ? [command] : exts.map((ext) => command + ext.toLowerCase());
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.win32.join(dir.replaceAll('"', ''), name);
      if (exists(candidate)) return candidate;
    }
  }

  return undefined;
}

/**
 * One argument for a batch file started by cmd.exe. First quote it the way
 * the program's own parser expects (CommandLineToArgvW), then caret-escape
 * every cmd character twice: once for the `cmd /c` line, and once more
 * because the batch file passes it on with %*, which cmd parses again.
 */
export function cmdArgument(arg: string): string {
  const quoted = `"${arg.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}
