/**
 * `dcd settings` — prints the active team's settings: concurrency, test
 * runtime, sign-in requirement, retry escalation, overage limit and which
 * integrations are connected. Read-only; change settings in the console.
 *
 * Owner/admin settings come back null for a standard member (the API sets
 * `restricted`), and are shown as such rather than as "off".
 */
import { defineCommand } from 'citty';

import { apiFlags } from '../config/flags/api.flags.js';
import { jsonFlag } from '../config/flags/output.flags.js';
import { ApiGateway } from '../gateways/api-gateway.js';
import type {
  Platform,
  SignInRequirement,
  TeamSettings,
} from '../types/domain/team-settings.types.js';
import { resolveAuth } from '../utils/auth.js';
import { logger } from '../utils/cli.js';
import { resolveApiUrl } from '../utils/config-store.js';
import { colors, formatId } from '../utils/styling.js';
import { type Field, ui } from '../utils/ui.js';

const OWNER_OR_ADMIN = colors.dim('owner or admin only');

const PLATFORM_LABELS: Record<Platform, string> = { android: 'Android', ios: 'iOS' };

// The console's wording for each level.
const SIGN_IN_LABELS: Record<SignInRequirement, string> = {
  off: 'off',
  passkey: 'a passkey',
  passkey_and_code: 'a passkey and a code',
  two_factor: 'two-factor',
};

const ESCALATION_TARGET_LABELS: Record<string, string> = { gpu1: 'GPU', m1: 'M1' };

function limit(min: number, max: number): string {
  return max <= 0 ? colors.dim('not enabled') : `min ${min} · max ${max}`;
}

function connected(value: boolean): string {
  return value ? 'connected' : colors.dim('not connected');
}

function signInRequirement(settings: TeamSettings): string {
  if (settings.signInRequirement === null) return OWNER_OR_ADMIN;
  return SIGN_IN_LABELS[settings.signInRequirement] ?? settings.signInRequirement;
}

function retryEscalation(settings: TeamSettings): string {
  const escalation = settings.retryEscalation;
  if (escalation === null) return OWNER_OR_ADMIN;
  if (!escalation.available || !escalation.target) return colors.dim('not available');
  const target = ESCALATION_TARGET_LABELS[escalation.target] ?? escalation.target;
  return `${escalation.enabled ? 'on' : 'off'} · Android retries move to ${target} runners`;
}

function overage(settings: TeamSettings): string {
  const value = settings.overage;
  if (value === null) return OWNER_OR_ADMIN;
  if (!value.hasSubscription) return colors.dim('no active subscription');
  if (value.limitUsd === null) return 'uncapped';
  return `$${value.limitUsd} per billing period, on top of included credits`;
}

function concurrencyRows(settings: TeamSettings): string[] {
  const { pools, runners } = settings.concurrency;
  const fields: Field[] = [
    ...runners.map(({ max, min, platform, runnerType }): Field => [
      `${PLATFORM_LABELS[platform] ?? platform} ${runnerType}`,
      limit(min, max),
    ]),
    ...pools.map(({ max, min, name }): Field => [`${name} pool`, limit(min, max)]),
  ];
  if (fields.length === 0) return [colors.dim('none')];

  const shared = pools.map(
    ({ members, name }) =>
      `${name} pool is shared by ${members
        .map((m) => `${PLATFORM_LABELS[m.platform] ?? m.platform} ${m.runnerType}`)
        .join(' and ')}`,
  );
  return [
    ...ui.fields(fields),
    ...shared.map((line) => ui.note(line)),
    ui.note('min: always available · max: when capacity allows'),
  ];
}

/** Human-readable output; one section per area, as in the console. */
export function renderTeamSettings(settings: TeamSettings): string[] {
  const { extendedMinutes, defaultMinutes } = settings.testRuntime;
  const lines = [
    ui.section('Team'),
    ui.branch(
      ui.fields([
        ['name', settings.name ?? colors.dim('(unnamed)')],
        ['org id', formatId(String(settings.orgId))],
        ['sign-in requirement', signInRequirement(settings)],
      ]),
    ),
    ui.section('Concurrency'),
    ui.branch(concurrencyRows(settings)),
    ui.section('Test Runtime'),
    ui.branch(
      ui.fields([
        ['default', `${defaultMinutes} min per flow`],
        [
          'extended',
          extendedMinutes === null
            ? colors.dim('off')
            : `${extendedMinutes} min per flow with EXTENDED_RUNTIME, charged at twice the rate`,
        ],
      ]),
    ),
    ui.section('Retries & Billing'),
    ui.branch(
      ui.fields([
        ['retry escalation', retryEscalation(settings)],
        ['overage limit', overage(settings)],
      ]),
    ),
    ui.section('Integrations'),
    ui.branch(
      ui.fields([
        ['webhook', connected(settings.integrations.webhook)],
        ['slack', connected(settings.integrations.slack)],
        ['github', connected(settings.integrations.github)],
      ]),
    ),
  ];
  if (settings.restricted) {
    lines.push('', ui.note('Some settings are shown to team owners and admins only.'));
  }

  return lines;
}

export const settingsCommand = defineCommand({
  meta: {
    name: 'settings',
    description: "Show your team's settings (read-only)",
  },
  args: {
    ...apiFlags,
    json: jsonFlag,
  },
  async run({ args }) {
    const apiKeyFlag = args['api-key'] as string | undefined;
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const json = Boolean(args.json);

    try {
      const auth = await resolveAuth({ apiKeyFlag });
      const settings = await ApiGateway.getTeamSettings(apiUrl, auth);

      if (json) {
        logger.json(settings);
        return;
      }

      for (const line of renderTeamSettings(settings)) logger.log(line);
    } catch (error) {
      logger.error(error as Error, { exit: 1, json });
    }
  },
});

export default settingsCommand;
