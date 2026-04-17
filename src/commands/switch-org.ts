/**
 * `dcd switch-org` — changes the active org on the stored session.
 *
 * With an argument (`dcd switch-org <id>`): update config immediately after
 * confirming the user is a member via GET /me/orgs.
 * Without an argument: fetch orgs and prompt the user to pick one.
 */
import * as p from '@clack/prompts';
import { defineCommand } from 'citty';

import { resolveAuth } from '../utils/auth';
import { CliError, logger } from '../utils/cli';
import { readConfig, writeConfig } from '../utils/config-store';
import { colors, symbols } from '../utils/styling';

interface OrgListItem {
  id: string;
  name: string;
  slug?: string;
}

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
      description: 'Org id or slug to switch to',
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
    if (orgs.length === 0) {
      throw new CliError('No organizations found for this user.');
    }

    let chosen: OrgListItem | undefined;
    if (target) {
      chosen = orgs.find((o) => o.id === target || o.slug === target);
      if (!chosen) {
        throw new CliError(
          `You are not a member of org "${target}". Available: ${orgs.map((o) => o.slug ?? o.id).join(', ')}`,
        );
      }
    } else {
      const picked = await p.select({
        message: 'Pick an organization',
        options: orgs.map((o) => ({ value: o.id, label: o.name })),
      });
      if (p.isCancel(picked)) throw new CliError('Cancelled.');
      chosen = orgs.find((o) => o.id === picked);
    }

    if (!chosen) throw new CliError('No organization selected.');

    writeConfig({
      ...config,
      current_org_id: chosen.id,
      current_org_name: chosen.name,
    });

    logger.log(
      `${symbols.success} Switched to ${colors.highlight(chosen.name)} ${colors.dim(`(${chosen.id})`)}`,
    );
  },
});

async function fetchOrgs(
  apiUrl: string,
  headers: Record<string, string>,
): Promise<OrgListItem[]> {
  const res = await fetch(`${apiUrl}/me/orgs`, { headers });
  if (!res.ok) {
    throw new CliError(`Failed to list organizations: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { orgs: OrgListItem[] };
  return body.orgs ?? [];
}

export default switchOrgCommand;
