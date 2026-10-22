/**
 * `dcd switch-org` — changes the active org on the stored session.
 *
 * With an argument (`dcd switch-org <name>`): update config immediately after
 * confirming the user is a member via GET /me/orgs.
 * Without an argument: fetch orgs and prompt the user to pick one (an error
 * instead when there's no TTY to answer the prompt).
 */
import { defineCommand } from 'citty';

import { jsonFlag } from '../config/flags/output.flags.js';
import { apiKeyOverride, resolveAuth } from '../utils/auth.js';
import { canPrompt } from '../utils/ci.js';
import { CliError, logger } from '../utils/cli.js';
import { readConfig, resolveApiUrl, writeConfig } from '../utils/config-store.js';
import { fetchOrgs, matchOrg, pickOrg, OrgListItem } from '../utils/orgs.js';
import { colors } from '../utils/styling.js';
import { ui } from '../utils/ui.js';

export const switchOrgCommand = defineCommand({
  meta: {
    name: 'switch-org',
    description: 'Switch the active organization for the logged-in session',
  },
  args: {
    'api-url': {
      type: 'string',
      description: 'API base URL (defaults to the URL stored by `dcd login`)',
    },
    org: {
      type: 'positional',
      required: false,
      description: 'Org name to switch to (omit for an interactive picker)',
    },
    json: jsonFlag,
  },
  async run({ args }) {
    const config = readConfig();
    if (!config?.session) {
      throw new CliError('Not logged in. Run `dcd login` first.');
    }

    // Honor the env the user logged into — defaulting to prod here would send
    // a dev Bearer token to the prod API.
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const target = args.org as string | undefined;
    const json = Boolean(args.json);

    // sessionOnly: an exported DEVICE_CLOUD_API_KEY must not shadow the
    // browser session this command requires.
    const auth = await resolveAuth({ apiKeyFlag: undefined, sessionOnly: true });

    const orgs = await fetchOrgs(apiUrl, auth.headers);

    let chosen: OrgListItem;
    if (target) {
      chosen = matchOrg(orgs, target, '`dcd switch-org` without arguments');
    } else {
      // Under --json the picker draws on stderr so stdout stays pure JSON.
      const output = json ? process.stderr : undefined;
      // Without a TTY the picker would wait forever for a keypress.
      if (orgs.length > 1 && !canPrompt(output)) {
        throw new CliError(
          `There's no terminal to pick an organization in. Run \`dcd switch-org <name>\` with one of: ${orgs.map((o) => o.name).join(', ')}`,
        );
      }
      chosen = await pickOrg(orgs, { output });
    }

    writeConfig({
      ...config,
      current_org_id: chosen.id,
      current_org_name: chosen.name,
    });

    // The switch only changes the stored session; an exported key still wins.
    const keyOverride = apiKeyOverride() === 'DEVICE_CLOUD_API_KEY';

    if (json) {
      logger.json({
        status: 'SUCCESS',
        org: { id: chosen.id, name: chosen.name, slug: chosen.slug ?? null },
        apiKeyOverride: keyOverride,
      });
      return;
    }

    logger.log(ui.success(`Switched to ${colors.highlight(chosen.name)}`));

    if (keyOverride) {
      logger.log(
        ui.warn(
          `${colors.highlight('DEVICE_CLOUD_API_KEY')} is set, so other dcd commands still authenticate with that API key and its org, not ${chosen.name}. Unset it to use the session.`,
        ),
      );
    }
  },
});

export default switchOrgCommand;
