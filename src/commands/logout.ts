/**
 * `dcd logout` — deletes the stored session. Local only: nothing is revoked
 * server-side, so the user stays signed in to the web app and any other CLI.
 * Leaves DEVICE_CLOUD_API_KEY (env/flag) untouched.
 */
import { defineCommand } from 'citty';

import { jsonFlag } from '../config/flags/output.flags.js';
import { logger } from '../utils/cli.js';
import { clearConfig, getConfigPath, readConfig } from '../utils/config-store.js';
import { colors } from '../utils/styling.js';
import { ui } from '../utils/ui.js';

export const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description: 'Clear the stored devicecloud.dev session',
  },
  args: {
    json: jsonFlag,
  },
  async run({ args }) {
    const json = Boolean(args.json);
    const config = readConfig();
    if (!config?.session) {
      clearConfig();
      if (json) {
        logger.json({ status: 'SUCCESS', loggedOut: false });
      } else {
        logger.log(ui.info(`No active session found (${colors.dim(getConfigPath())}).`));
      }
      return;
    }

    clearConfig();
    if (json) {
      logger.json({ status: 'SUCCESS', loggedOut: true, user: config.session.user_email });
      return;
    }
    logger.log(ui.success(`Logged out ${colors.dim(`(${config.session.user_email})`)}`));
  },
});

export default logoutCommand;
