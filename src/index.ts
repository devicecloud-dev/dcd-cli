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

runMain(main);
