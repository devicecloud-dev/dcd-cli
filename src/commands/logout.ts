/**
 * `dcd logout` — clears the stored Supabase session and best-effort revokes
 * it on Supabase. Leaves DEVICE_CLOUD_API_KEY (env/flag) untouched.
 */
import { defineCommand } from 'citty';

import { ENVIRONMENTS } from '../config/environments.js';
import { CliAuthGateway } from '../gateways/cli-auth-gateway.js';
import { logger } from '../utils/cli.js';
import { clearConfig, getConfigPath, readConfig } from '../utils/config-store.js';
import { colors } from '../utils/styling.js';
import { ui } from '../utils/ui.js';

export const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description: 'Clear the stored devicecloud.dev session',
  },
  async run() {
    const config = readConfig();
    if (!config?.session) {
      logger.log(ui.info(`No active session found (${colors.dim(getConfigPath())}).`));
      clearConfig();
      return;
    }

    const { anonKey } = ENVIRONMENTS[config.env].supabase;
    await CliAuthGateway.signOut(config.supabase_url, anonKey, config.session);
    clearConfig();
    logger.log(ui.success(`Logged out ${colors.dim(`(${config.session.user_email})`)}`));
  },
});

export default logoutCommand;
