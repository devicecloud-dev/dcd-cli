/**
 * Shared helpers for fetching, matching and picking from /me/orgs. Used by
 * both `dcd login` (after the PKCE claim returns a session) and `dcd switch-org`.
 */
import * as p from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';

import { CliError } from './cli.js';

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
    const body = await res.text().catch(() => '');
    throw new CliError(
      `Failed to list organizations: HTTP ${res.status}${body ? ` — ${body}` : ''}`,
    );
  }
  const body = (await res.json()) as { orgs: OrgListItem[] };
  return body.orgs ?? [];
}

/**
 * Match a user-supplied string to an org. Prefers case-insensitive name match.
 * Falls back to slug / id so existing scripts keep working, but error output
 * only surfaces names. `pickCommand` is how to pick interactively instead,
 * for when two orgs share a name.
 */
export function matchOrg(
  orgs: OrgListItem[],
  target: string,
  pickCommand: string,
): OrgListItem {
  const needle = target.toLowerCase();
  const nameMatches = orgs.filter((o) => o.name.toLowerCase() === needle);
  if (nameMatches.length > 1) {
    throw new CliError(
      `Multiple orgs named "${target}". Run ${pickCommand} to pick interactively.`,
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

export interface PickOrgOptions {
  message?: string;
  /** Org to start the picker on, so Enter confirms it. Ignored if not listed. */
  initialId?: string;
  input?: Readable;
  output?: Writable;
}

/**
 * Interactive org picker. Auto-selects when there's only one org (returns it
 * without prompting). Throws on zero orgs or user cancellation.
 */
export async function pickOrg(
  orgs: OrgListItem[],
  {
    message = 'Pick an organization',
    initialId,
    input,
    output,
  }: PickOrgOptions = {},
): Promise<OrgListItem> {
  if (orgs.length === 0) {
    throw new CliError('No organizations found for this user.');
  }
  if (orgs.length === 1) return orgs[0];

  const picked = await p.select({
    message,
    input,
    output,
    options: orgs.map((o) => ({ value: o.id, label: o.name })),
    // clack starts on the first option when this isn't one of them.
    initialValue: initialId,
  });
  if (p.isCancel(picked)) throw new CliError('Cancelled.');

  const chosen = orgs.find((o) => o.id === picked);
  if (!chosen) throw new CliError('No organization selected.');
  return chosen;
}

export interface SelectOrgOptions {
  /** `dcd login --org`: a name, slug or id. Skips the picker. */
  requested?: string;
  /** The org the last login chose. */
  lastOrgId?: string;
  /** Whether anyone can answer the picker (see canPrompt). */
  interactive: boolean;
  input?: Readable;
  output?: Writable;
}

/**
 * Choose the org for `dcd login`: `--org` if given, else the only org, else
 * the picker starting on the last login's org. Without a TTY nobody can
 * answer the picker, so the last login's org is used without asking, and
 * when there isn't one the error names `--org` instead of hanging.
 * `fromLastLogin` is set when that fallback chose the org, so the caller
 * can say so.
 */
export async function selectOrg(
  orgs: OrgListItem[],
  { requested, lastOrgId, interactive, input, output }: SelectOrgOptions,
): Promise<{ org: OrgListItem; fromLastLogin: boolean }> {
  if (orgs.length === 0) {
    throw new CliError('No organizations found for this user.');
  }
  if (requested !== undefined) {
    return {
      org: matchOrg(orgs, requested, '`dcd login` without --org'),
      fromLastLogin: false,
    };
  }
  if (orgs.length === 1) return { org: orgs[0], fromLastLogin: false };

  if (!interactive) {
    const last = orgs.find((o) => o.id === lastOrgId);
    if (last) return { org: last, fromLastLogin: true };

    const reason = lastOrgId
      ? "The organization from your last login is no longer available, and there's no terminal to pick another in."
      : "You belong to more than one organization, and there's no terminal to pick one in.";
    throw new CliError(
      `${reason} Run \`dcd login --org <name>\` with one of: ${orgs.map((o) => o.name).join(', ')}`,
    );
  }

  return {
    org: await pickOrg(orgs, { initialId: lastOrgId, input, output }),
    fromLastLogin: false,
  };
}
