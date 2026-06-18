#!/usr/bin/env node
import type { CommandDef, SubCommandsDef } from 'citty';
import { defineCommand, runCommand, showUsage } from 'citty';

import { artifactsCommand } from './commands/artifacts';
import { cloudCommand } from './commands/cloud';
import { listCommand } from './commands/list';
import { liveCommand } from './commands/live';
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { statusCommand } from './commands/status';
import { switchOrgCommand } from './commands/switch-org';
import { upgradeCommand } from './commands/upgrade';
import { uploadCommand } from './commands/upload';
import { whoamiCommand } from './commands/whoami';
import { telemetry } from './services/telemetry.service';
import { CliError, getCliVersion, logger } from './utils/cli';

const main = defineCommand({
  meta: {
    name: 'dcd',
    version: getCliVersion(),
    description:
      'devicecloud.dev CLI — a drop-in replacement for `maestro cloud`',
  },
  subCommands: {
    cloud: cloudCommand,
    upload: uploadCommand,
    list: listCommand,
    status: statusCommand,
    artifacts: artifactsCommand,
    live: liveCommand,
    login: loginCommand,
    logout: logoutCommand,
    whoami: whoamiCommand,
    'switch-org': switchOrgCommand,
    upgrade: upgradeCommand,
  },
});

// citty's runMain catches every error internally and calls process.exit(1),
// so its returned promise never rejects — failure telemetry hooked onto it
// would be dead code, CliError.exitCode would be ignored, and raw stack
// traces would be printed for usage errors. This replicates runMain's
// help/version/usage behaviour with those three problems fixed. Telemetry
// configure is deferred to `resolveAuth` (only authenticated commands ship
// telemetry — see telemetry.service.ts); unauthenticated invocations buffer
// in memory and drop on exit, which is the desired behaviour.

async function resolveValue<T>(input: T | (() => T | Promise<T>)): Promise<T> {
  return typeof input === 'function'
    ? (input as () => T | Promise<T>)()
    : input;
}

// Mirrors citty's internal (unexported) resolveSubCommand so usage errors can
// show the help of the subcommand that failed rather than the root command.
async function resolveSubCommand(
  cmd: CommandDef,
  rawArgs: string[],
  parent?: CommandDef,
): Promise<[CommandDef, CommandDef?]> {
  const subCommands = await resolveValue(cmd.subCommands as SubCommandsDef | undefined);
  if (subCommands && Object.keys(subCommands).length > 0) {
    const subCommandArgIndex = rawArgs.findIndex((arg) => !arg.startsWith('-'));
    const subCommandName = rawArgs[subCommandArgIndex];
    const subCommand = await resolveValue(subCommands[subCommandName]);
    if (subCommand) {
      return resolveSubCommand(
        subCommand,
        rawArgs.slice(subCommandArgIndex + 1),
        cmd,
      );
    }
  }
  return [cmd, parent];
}

async function run(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  telemetry.recordCommandStart();
  try {
    if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
      await showUsage(...(await resolveSubCommand(main, rawArgs)));
    } else if (rawArgs.length === 1 && rawArgs[0] === '--version') {
      logger.log(getCliVersion());
    } else {
      await runCommand(main, { rawArgs });
    }
    telemetry.recordCommandSuccess();
    await telemetry.flush();
  } catch (error) {
    // citty throws CLIError (by name — the class isn't exported) for usage
    // problems like unknown commands or missing required args.
    if (error instanceof Error && error.name === 'CLIError') {
      await showUsage(...(await resolveSubCommand(main, rawArgs)));
    }

    const exitCode = error instanceof CliError ? error.exitCode : 1;
    // logger.error prints the message, records failure telemetry, flushes
    // synchronously, and exits with the given code.
    logger.error(error instanceof Error ? error : String(error), {
      exit: exitCode,
    });
  }
}

void run();
