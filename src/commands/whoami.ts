/**
 * `dcd whoami` — prints the logged-in user + active org from stored config.
 */
import { defineCommand } from 'citty';

import { logger } from '../utils/cli';
import { readConfig } from '../utils/config-store';
import { colors, sectionHeader, symbols } from '../utils/styling';

export const whoamiCommand = defineCommand({
  meta: {
    name: 'whoami',
    description: 'Show the logged-in user and active organization',
  },
  run() {
    const config = readConfig();
    if (!config?.session) {
      logger.log(
        `${symbols.info} Not logged in. Run ${colors.highlight('dcd login')} or set ${colors.highlight('DEVICE_CLOUD_API_KEY')}.`,
      );
      return;
    }
    logger.log(sectionHeader('devicecloud.dev'));
    logger.log(`   ${colors.dim('User:')} ${colors.highlight(config.session.user_email)}`);
    if (config.current_org_name) {
      logger.log(`   ${colors.dim('Org:')}  ${colors.highlight(config.current_org_name)}`);
    } else if (config.current_org_id) {
      // Fallback for sessions stored before we persisted org name alongside id.
      logger.log(`   ${colors.dim('Org:')}  ${colors.highlight(config.current_org_id)}`);
    }
    logger.log(`   ${colors.dim('Env:')}  ${config.env}`);
  },
});

export default whoamiCommand;
