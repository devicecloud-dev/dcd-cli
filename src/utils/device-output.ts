import { DeviceApiError, DeviceGateway } from '../gateways/device-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import type { DeviceHumanStatus, DeviceSession } from '../types/domain/device-session.types.js';
import { CliError, logger } from './cli.js';
import { colors, formatUrl } from './styling.js';
import { type Field, ui } from './ui.js';

/**
 * Exit codes for `dcd device` (dcd docs/device-v1-plan.md, section 4.2).
 * Scripts and agents branch on these, so they are a contract.
 */
export const DEVICE_EXIT = {
  ok: 0,
  /** Called wrongly: a bad flag, a bad value, or no session to pick. */
  usage: 1,
  /** It ran and failed: a flow or action failed, or the API could not do it. */
  failed: 2,
  /** A limit: concurrency, spend cap or rate limit. */
  limit: 3,
  /** The session has ended, or there is no such session. */
  gone: 4,
} as const;

const LIMIT_CODES = new Set(['LIVE_CONCURRENCY_LIMIT', 'LIVE_RATE_LIMITED', 'LIVE_SPEND_CAP']);
const GONE_CODES = new Set(['LIVE_NOT_FOUND', 'LIVE_SESSION_ENDED']);
const USAGE_CODES = new Set([
  'LIVE_INVALID_ACTION',
  'LIVE_INVALID_APP',
  'LIVE_SESSION_REQUIRED',
]);

export function deviceExitCode(error: unknown): number {
  if (error instanceof DeviceApiError) {
    if (error.code && GONE_CODES.has(error.code)) return DEVICE_EXIT.gone;
    if (error.code && LIMIT_CODES.has(error.code)) return DEVICE_EXIT.limit;
    if (error.code && USAGE_CODES.has(error.code)) return DEVICE_EXIT.usage;
    if (error.status === 404) return DEVICE_EXIT.gone;
    if (error.status === 429) return DEVICE_EXIT.limit;
    if ([400, 401, 403].includes(error.status)) return DEVICE_EXIT.usage;
    return DEVICE_EXIT.failed;
  }

  if (error instanceof CliError) return error.exitCode;
  return DEVICE_EXIT.failed;
}

/**
 * The one object `--json` prints, on success and on failure alike. `session`
 * is left out by the commands that are not about one session (`list`,
 * `models`, `stop --all`), so it never reads as "no session".
 */
export interface DeviceEnvelope<T> {
  ok: boolean;
  session?: DeviceSession | null;
  data: T | null;
  error: { code: null | string; message: string } | null;
}

export interface DeviceOutcome<T> {
  /** The session the command was about; undefined when it is not about one. */
  session: DeviceSession | null | undefined;
  data: T;
  /** Prints the result for a person. Not called under --json. */
  print(): void;
  /**
   * Set when the command ran but did not succeed (a failed launch, a failed
   * flow). The CLI then exits 2, still printing `data`.
   */
  failure?: { code: null | string; message: string };
}

/**
 * Runs one `dcd device` command and prints its result: one envelope under
 * --json, readable text otherwise. Errors leave with the matching exit code.
 * Under --json the error is printed here, as an envelope, so the top-level
 * handler's `{ status, error }` never appears.
 */
export async function runDeviceCommand<T>(
  json: boolean,
  fn: () => Promise<DeviceOutcome<T>>,
): Promise<void> {
  let outcome: DeviceOutcome<T>;
  try {
    outcome = await fn();
  } catch (error) {
    const exitCode = deviceExitCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (!json) throw new CliError(message, exitCode);
    const envelope: DeviceEnvelope<never> = {
      ok: false,
      session: error instanceof DeviceApiError ? error.session : null,
      data: null,
      error: { code: error instanceof DeviceApiError ? error.code : null, message },
    };
    logger.json(envelope);
    logger.fail(message, exitCode);
  }

  if (json) {
    const envelope: DeviceEnvelope<T> = {
      ok: !outcome.failure,
      ...(outcome.session !== undefined && { session: outcome.session }),
      data: outcome.data,
      error: outcome.failure ?? null,
    };
    logger.json(envelope);
  } else {
    outcome.print();
  }

  if (outcome.failure) logger.fail(outcome.failure.message, DEVICE_EXIT.failed);
}

/**
 * Progress for a person, on stderr, so stdout carries only the result. Off
 * under --json. These are plain lines, never a spinner, so they read the same
 * in a terminal, a CI log or an agent's tool output.
 */
export function deviceProgress(json: boolean): (message: string) => void {
  return (message) => {
    if (!json) process.stderr.write(`${message}\n`);
  };
}

/**
 * The default-session rule: `<id>` may be left out when the org has exactly
 * one open session. With none, or several, the command is a usage error and
 * lists what there is to choose from.
 */
export async function resolveSessionId(
  apiUrl: string,
  auth: AuthContext,
  given: string | undefined,
): Promise<string> {
  const id = given?.trim();
  if (id) return id;

  const { sessions } = await DeviceGateway.list(apiUrl, auth);
  if (sessions.length === 1) return sessions[0].id;
  if (sessions.length === 0) {
    throw new CliError(
      'No open device session. Start one with `dcd device start --platform ios|android`.',
      DEVICE_EXIT.usage,
    );
  }

  const candidates = sessions
    .map((s) => `  ${s.id}  ${s.platform}  ${s.state}${s.client_label ? `  ${s.client_label}` : ''}`)
    .join('\n');
  throw new CliError(
    `${sessions.length} device sessions are open. Name one:\n${candidates}`,
    DEVICE_EXIT.usage,
  );
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** The rows that describe a session, for {@link ui.fields}. */
export function sessionFields(session: DeviceSession): Field[] {
  const fields: Field[] = [
    ['session', colors.highlight(session.id)],
    ['state', session.release_reason ? `${session.state} (${session.release_reason})` : session.state],
    ['platform', session.platform],
  ];
  if (session.model) fields.push(['model', session.model]);
  if (session.client_label) fields.push(['client', session.client_label]);
  if (session.queue) {
    const position = session.queue.position === null ? '' : `#${session.queue.position}`;
    const eta = session.queue.eta_s === null ? '' : `, about ${formatSeconds(session.queue.eta_s)}`;
    fields.push(['queue', `${position || 'waiting'}${eta} (${session.queue.reason.replaceAll('_', ' ')})`]);
  }

  if (session.time_remaining_s !== null) {
    fields.push(['time left', formatSeconds(session.time_remaining_s)]);
  }

  if (session.idle_remaining_s !== null) {
    fields.push(['idle timeout', `in ${formatSeconds(session.idle_remaining_s)}`]);
  }

  if (session.cost_so_far_usd !== null) {
    fields.push(['cost so far', `$${session.cost_so_far_usd.toFixed(2)}`]);
  }

  if (session.last_crash) {
    fields.push(['last crash', colors.error(`${session.last_crash.summary} (${session.last_crash.at})`)]);
  }

  fields.push(['monitor', formatUrl(session.monitor_url)]);
  return fields;
}

/** A session as a branch group, with its warnings after it. */
export function printSession(session: DeviceSession): void {
  logger.log(ui.branch(ui.fields(sessionFields(session))));
  for (const warning of session.warnings) logger.log(ui.warn(warning));
}

/**
 * An API timestamp for a person: how far off it is and the local time, e.g.
 * "in 12m (14:32)" or "3m ago (14:17)". The text as given when unreadable.
 */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const seconds = Math.round((at - now) / 1000);
  if (Math.abs(seconds) < 5) return `now (${clock})`;
  return seconds > 0
    ? `in ${formatSeconds(seconds)} (${clock})`
    : `${formatSeconds(-seconds)} ago (${clock})`;
}

/** Where the hand-over stands, in a few words. */
export function humanState(human: DeviceHumanStatus): string {
  if (human.human_in_control) return 'a person has control';
  if (human.waiting) return 'waiting for a person';
  if (human.handed_back) return 'handed back';
  return 'no help asked for';
}

/** The rows that describe a request for a person, for {@link ui.fields}. */
export function humanFields(human: DeviceHumanStatus, now: number = Date.now()): Field[] {
  const fields: Field[] = [['state', humanState(human)]];
  if (human.reason) fields.push(['reason', human.reason]);
  if (human.since) fields.push(['asked', formatWhen(human.since, now)]);
  if (human.waiting && human.expires_at) {
    fields.push(['ends', `${formatWhen(human.expires_at, now)} unless they hand it back`]);
  }

  if (human.handed_back && human.handed_back_at) {
    fields.push(['handed back', formatWhen(human.handed_back_at, now)]);
  }

  if (human.handed_back) fields.push(['note', human.note ?? colors.dim('none')]);
  return fields;
}
