/**
 * `dcd switch-org` — changes the active org on the stored session.
 *
 * With an argument (`dcd switch-org <name>`): update config immediately after
 * confirming the user is a member via GET /me/orgs.
 * Without an argument: fetch orgs and prompt the user to pick one.
 */
import { defineCommand } from 'citty';

import { resolveAuth } from '../utils/auth.js';
import { CliError, logger } from '../utils/cli.js';
import { readConfig, resolveApiUrl, writeConfig } from '../utils/config-store.js';
import { fetchOrgs, pickOrg, OrgListItem } from '../utils/orgs.js';
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

    // sessionOnly: an exported DEVICE_CLOUD_API_KEY must not shadow the
    // browser session this command requires.
    const auth = await resolveAuth({ apiKeyFlag: undefined, sessionOnly: true });

    const orgs = await fetchOrgs(apiUrl, auth.headers);

    let chosen: OrgListItem;
    if (target) {
      chosen = matchOrg(orgs, target);
    } else {
      chosen = await pickOrg(orgs);
    }

    writeConfig({
      ...config,
      current_org_id: chosen.id,
      current_org_name: chosen.name,
    });

    logger.log(ui.success(`Switched to ${colors.highlight(chosen.name)}`));
  },
});

/**
 * Match a user-supplied string to an org. Prefers case-insensitive name match.
 * Falls back to slug / id so existing scripts keep working, but error output
 * only surfaces names.
 */
function matchOrg(orgs: OrgListItem[], target: string): OrgListItem {
  const needle = target.toLowerCase();
  const nameMatches = orgs.filter((o) => o.name.toLowerCase() === needle);
  if (nameMatches.length > 1) {
    throw new CliError(
      `Multiple orgs named "${target}". Run \`dcd switch-org\` without arguments to pick interactively.`,
    );
  }
  const chosen =
    nameMatches[0] ?? orgs.find((o) => o.slug === target || o.id === target);
  if (!chosen) {
    throw new CliError(
      `No org named "${target}". Available: ${orgs.map((o) => o.name).join(', ')}`,
    );
  }
  return chosen;
}

export default switchOrgCommand;
