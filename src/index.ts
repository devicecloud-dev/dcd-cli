#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';

import { artifactsCommand } from './commands/artifacts';
import { cloudCommand } from './commands/cloud';
import { listCommand } from './commands/list';
import { liveCommand } from './commands/live';
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { statusCommand } from './commands/status';
import { switchOrgCommand } from './commands/switch-org';
import { uploadCommand } from './commands/upload';
import { whoamiCommand } from './commands/whoami';
import { telemetry } from './services/telemetry.service';
import { getCliVersion } from './utils/cli';

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
  },
});

// Wrap runMain so we can record start/success/failure around it. Configure is
// deferred to `resolveAuth` (only authenticated commands ship telemetry — see
// telemetry.service.ts for the rationale). If the user runs `--help` or
// errors out before reaching auth, telemetry buffers in memory and is dropped
// on exit, which is the desired behaviour.
telemetry.recordCommandStart();
runMain(main).then(
  async () => {
    telemetry.recordCommandSuccess();
    await telemetry.flush();
  },
  (error: unknown) => {
    telemetry.recordCommandFailure({
      error: error instanceof Error ? error : String(error),
      exitCode: 1,
    });
    telemetry.flushSync();
    throw error;
  },
);
