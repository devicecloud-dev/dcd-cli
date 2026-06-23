/**
 * `dcd whoami` — prints the logged-in user + active org from stored config.
 */
import { defineCommand } from 'citty';

import { logger } from '../utils/cli.js';
import { readConfig } from '../utils/config-store.js';
import { colors, formatId } from '../utils/styling.js';
import { type Field, ui } from '../utils/ui.js';

export const whoamiCommand = defineCommand({
  meta: {
    name: 'whoami',
    description: 'Show the logged-in user and active organization',
  },
  run() {
    const config = readConfig();
    if (!config?.session) {
      logger.log(
        ui.info(
          `Not logged in. Run ${colors.highlight('dcd login')} or set ${colors.highlight('DEVICE_CLOUD_API_KEY')}.`,
        ),
      );
      return;
    }

    // Fallback for sessions stored before we persisted org name alongside id.
    const org = config.current_org_name ?? config.current_org_id;

    const fields: Field[] = [['user', formatId(config.session.user_email)]];
    if (org) {
      fields.push(['org', formatId(org)]);
    }
    fields.push(['env', config.env]);

    logger.log(ui.section('devicecloud.dev'));
    logger.log(ui.branch(ui.fields(fields)));
  },
});

export default whoamiCommand;
