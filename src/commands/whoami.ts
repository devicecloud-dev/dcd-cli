/**
 * `dcd whoami` — prints the logged-in user + active org from stored config.
 *
 * It reads only the stored `dcd login` session, while every other command
 * prefers an API key from --api-key or DEVICE_CLOUD_API_KEY — so when one is
 * present it says so, rather than implying the session is what they use.
 */
import { defineCommand } from 'citty';

import { apiKeyOverride } from '../utils/auth.js';
import { logger } from '../utils/cli.js';
import { readConfig } from '../utils/config-store.js';
import { colors, formatId } from '../utils/styling.js';
import { type Field, ui } from '../utils/ui.js';

export const whoamiCommand = defineCommand({
  meta: {
    name: 'whoami',
    description: 'Show the logged-in user and active organization',
  },
  args: {
    'api-key': {
      type: 'string',
      alias: ['apiKey'],
      description:
        'An API key as you would pass it to other commands; whoami says that it takes precedence over the stored session',
    },
  },
  run({ args }) {
    const config = readConfig();
    const keySource = apiKeyOverride(args['api-key'] as string | undefined);
    const keyName = colors.highlight(keySource ?? '');

    if (!config?.session) {
      logger.log(
        ui.info(
          keySource === 'DEVICE_CLOUD_API_KEY'
            ? `Not logged in. ${keyName} is set, so dcd commands authenticate with that API key.`
            : keySource === '--api-key'
              ? `Not logged in. Commands given ${keyName} authenticate with that API key.`
              : `Not logged in. Run ${colors.highlight('dcd login')} or set ${colors.highlight('DEVICE_CLOUD_API_KEY')}.`,
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

    if (keySource === 'DEVICE_CLOUD_API_KEY') {
      logger.log(
        ui.warn(
          `${keyName} is set, so other dcd commands authenticate with that API key and its org, not this session. Unset it to use the session.`,
        ),
      );
    } else if (keySource === '--api-key') {
      logger.log(
        ui.warn(
          `Commands given ${keyName} authenticate with that API key and its org, not this session.`,
        ),
      );
    }
  },
});

export default whoamiCommand;
