/**
 * Shared helpers for fetching and picking from /me/orgs. Used by both
 * `dcd login` (after the PKCE claim returns a session) and `dcd switch-org`.
 */
import * as p from '@clack/prompts';

import { CliError } from './cli';

export interface OrgListItem {
  id: string;
  name: string;
  slug?: string;
}

export async function fetchOrgs(
  apiUrl: string,
  headers: Record<string, string>,
): Promise<OrgListItem[]> {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/me/orgs`, { headers });
  if (!res.ok) {
    throw new CliError(`Failed to list organizations: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { orgs: OrgListItem[] };
  return body.orgs ?? [];
}

/**
 * Interactive org picker. Auto-selects when there's only one org (returns it
 * without prompting). Throws on zero orgs or user cancellation.
 */
export async function pickOrg(
  orgs: OrgListItem[],
  message = 'Pick an organization',
): Promise<OrgListItem> {
  if (orgs.length === 0) {
    throw new CliError('No organizations found for this user.');
  }
  if (orgs.length === 1) return orgs[0];

  const picked = await p.select({
    message,
    options: orgs.map((o) => ({ value: o.id, label: o.name })),
  });
  if (p.isCancel(picked)) throw new CliError('Cancelled.');

  const chosen = orgs.find((o) => o.id === picked);
  if (!chosen) throw new CliError('No organization selected.');
  return chosen;
}
