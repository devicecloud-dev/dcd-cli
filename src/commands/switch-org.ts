/**
 * `dcd switch-org` — changes the active org on the stored session.
 *
 * With an argument (`dcd switch-org <name>`): update config immediately after
 * confirming the user is a member via GET /me/orgs.
 * Without an argument: fetch orgs and prompt the user to pick one.
 */
import { defineCommand } from 'citty';

import { resolveAuth } from '../utils/auth';
import { CliError, logger } from '../utils/cli';
import { readConfig, writeConfig } from '../utils/config-store';
import { fetchOrgs, pickOrg, OrgListItem } from '../utils/orgs';
import { colors, symbols } from '../utils/styling';

export const switchOrgCommand = defineCommand({
  meta: {
    name: 'switch-org',
    description: 'Switch the active organization for the logged-in session',
  },
  args: {
    'api-url': {
      type: 'string',
      default: 'https://api.devicecloud.dev',
      description: 'API base URL',
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

    const apiUrl = args['api-url'] as string;
    const target = args.org as string | undefined;

    const auth = await resolveAuth({ apiKeyFlag: undefined });
    if (auth.mode !== 'bearer') {
      throw new CliError('`dcd switch-org` requires a browser login, not an API key.');
    }

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

    logger.log(`${symbols.success} Switched to ${colors.highlight(chosen.name)}`);
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
