import { stripVTControlCharacters } from 'node:util';

import { DeviceApiError, DeviceGateway } from '../gateways/device-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import type { DeviceHumanStatus, DeviceSession, DeviceSessionStarter } from '../types/domain/device-session.types.js';
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
  /** A limit: concurrency, a spend cap or usage limit, or a rate limit. */
  limit: 3,
  /** The session has ended, or there is no such session. */
  gone: 4,
} as const;

// USAGE_LIMIT_EXCEEDED: the team's overage cap or a usage alert's hard stop
// refused a session start, as it refuses a test run.
const LIMIT_CODES = new Set([
  'LIVE_CONCURRENCY_LIMIT',
  'LIVE_RATE_LIMITED',
  'LIVE_SPEND_CAP',
  'USAGE_LIMIT_EXCEEDED',
]);
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
  /**
   * With `code` and `message`, whatever else the API said that a script can
   * act on: `retry_after_s`, `limit`, `spent`, `phase`, and `command_id` when
   * a wait for a flow gave up.
   */
  error: ({ code: null | string; message: string } & Record<string, unknown>) | null;
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
      error:
        error instanceof DeviceApiError
          ? { ...error.details, code: error.code, message }
          : { code: null, message },
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
 * The default-session rule: `<id>` may be left out when you have exactly one
 * open session. Other people's sessions are never the default: a teammate's
 * agent may be using one. With none of yours, or several, the command is a
 * usage error that lists what there is to choose from.
 *
 * An API that does not say who started each session (no `started_by`) is
 * read the old way: the org's only open session.
 */
export async function resolveSessionId(
  apiUrl: string,
  auth: AuthContext,
  given: string | undefined,
): Promise<string> {
  const id = checkSessionId(given);
  if (id) return id;

  const { sessions } = await DeviceGateway.list(apiUrl, auth);
  const knowsOwners = sessions.some((s) => s.started_by !== undefined);
  const yours = knowsOwners ? sessions.filter((s) => s.started_by?.you) : sessions;
  if (yours.length === 1) return yours[0].id;
  if (sessions.length === 0) {
    throw new CliError(
      'No open device session. Start one with `dcd device start --platform ios|android`.',
      DEVICE_EXIT.usage,
    );
  }

  const candidates = (list: DeviceSession[]) =>
    list
      .map((s) => {
        const who = s.started_by ? startedByLabel(s.started_by) : '';
        return `  ${s.id}  ${s.platform}  ${s.state}${s.client_label ? `  ${s.client_label}` : ''}${who ? `  (${who})` : ''}`;
      })
      .join('\n');
  if (yours.length === 0) {
    throw new CliError(
      `None of the open device sessions is yours. Start your own, or name one of these (changing it needs --force):\n${candidates(sessions)}`,
      DEVICE_EXIT.usage,
    );
  }

  throw new CliError(
    `${yours.length} of your device sessions are open. Name one:\n${candidates(yours)}`,
    DEVICE_EXIT.usage,
  );
}

/**
 * A session id: its name (`brave-teal-otter`, `brave-teal-otter-0042`, or an
 * older `teal-otter-42`), or its number. Words joined by dashes, so a single
 * word is never one.
 */
const SESSION_ID = /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)+|\d+)$/;

/** What a shell or a script prints for a value it does not have. */
const UNSET_WORDS = new Set(['', 'null', 'undefined', 'none', 'nan', 'nil', '[object object]']);

/**
 * The id given, trimmed, or undefined when none was. A value that cannot be
 * a session id is a usage error, never sent: `undefined` from a script's
 * unset variable would otherwise reach the API as a session name.
 */
export function checkSessionId(given: string | undefined): string | undefined {
  if (given === undefined) return undefined;
  const id = given.trim();
  if (!id) return undefined;
  if (SESSION_ID.test(id)) return id;
  const unset = UNSET_WORDS.has(id.toLowerCase());
  throw new CliError(
    unset
      ? `"${id}" is not a session id: it looks like a variable that was not set. A session id looks like brave-teal-otter; \`dcd device list\` shows yours.`
      : `"${id}" is not a session id. A session id looks like brave-teal-otter; \`dcd device list\` shows yours.`,
    DEVICE_EXIT.usage,
  );
}

/**
 * For commands that read what a session left behind (`artifacts`): the
 * session given, or else your most recent one, ended or not. Others' sessions
 * are never the default. An API that does not say who started each is read
 * the old way: the only session in the list.
 */
export async function resolveRecentSessionId(
  apiUrl: string,
  auth: AuthContext,
  given: string | undefined,
): Promise<string> {
  const id = checkSessionId(given);
  if (id) return id;

  // Open sessions and those that ended in the last day, newest first by start.
  const { sessions } = await DeviceGateway.list(apiUrl, auth, true);
  const knowsOwners = sessions.some((s) => s.started_by !== undefined);
  const newestFirst = (list: DeviceSession[]) =>
    [...list].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (knowsOwners) {
    const [newest] = newestFirst(sessions.filter((s) => s.started_by?.you));
    if (newest) return newest.id;
  } else if (sessions.length === 1) {
    return sessions[0].id;
  }

  if (sessions.length === 0) {
    throw new CliError('No device session in the last day. Name one: `dcd device artifacts <id>`.', DEVICE_EXIT.usage);
  }

  const listed = newestFirst(sessions)
    .map((s) => `  ${s.id}  ${s.platform}  ${s.state}${s.started_by ? `  (${startedByLabel(s.started_by)})` : ''}`)
    .join('\n');
  throw new CliError(
    knowsOwners
      ? `None of the sessions of the last day is yours. Name one:\n${listed}`
      : `Name the session:\n${listed}`,
    DEVICE_EXIT.usage,
  );
}

/** Who started a session, in a few words: "you", an email, or an API key's name. */
export function startedByLabel(starter: DeviceSessionStarter): string {
  if (starter.you) return starter.this_client ? 'you, this connection' : 'you';
  if (starter.email) return `started by ${printable(starter.email, { oneLine: true })}`;
  if (starter.api_key_name) return `started with API key "${printable(starter.api_key_name, { oneLine: true })}"`;
  return 'started by someone else';
}

/** Control characters other than tab and newline, C1 controls, and bidirectional overrides. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Text from the device, the app or another client, made safe to print in a
 * terminal: escape sequences and control characters removed, so an element's
 * label, a log line or a note can't retitle the terminal, move the cursor or
 * draw a fake result line. `oneLine` also folds line breaks into spaces, for
 * text shown inside a row. --json output keeps the text exactly as it came.
 */
export function printable(text: string, opts: { oneLine?: boolean } = {}): string {
  const clean = stripVTControlCharacters(text).replaceAll(CONTROL, '');
  return opts.oneLine ? clean.replaceAll(/[\t\n]+/g, ' ') : clean;
}

/**
 * Dollars for a person. Sessions are billed in units of $0.015, so a cost
 * is shown to the half cent when it has one: $0.015, not $0.01.
 */
export function formatCost(usd: number): string {
  const tenths = Math.round(usd * 1000);
  return tenths % 10 === 0 ? `$${usd.toFixed(2)}` : `$${(tenths / 1000).toFixed(3)}`;
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
  if (session.model) fields.push(['model', printable(session.model, { oneLine: true })]);
  if (session.client_label) fields.push(['client', printable(session.client_label, { oneLine: true })]);
  if (session.started_by) fields.push(['started', startedByLabel(session.started_by)]);
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
    fields.push(['cost so far', formatCost(session.cost_so_far_usd)]);
  }

  if (session.last_crash) {
    fields.push([
      'last crash',
      colors.error(`${printable(session.last_crash.summary, { oneLine: true })} (${session.last_crash.at})`),
    ]);
  }

  fields.push(['monitor', formatUrl(session.monitor_url)]);
  return fields;
}

/** A session as a branch group, with its warnings after it. */
export function printSession(session: DeviceSession): void {
  logger.log(ui.branch(ui.fields(sessionFields(session))));
  printWarnings(session);
}

/**
 * The session's warnings (a crash, the idle timeout or the end of its time
 * coming up, an install still going), after a command's own result: a
 * person or an agent driving it without --json must see them before the
 * session ends under them.
 */
export function printWarnings(session: DeviceSession | null | undefined): void {
  for (const warning of session?.warnings ?? []) logger.log(ui.warn(printable(warning)));
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
  if (human.reason) fields.push(['reason', printable(human.reason, { oneLine: true })]);
  // A person who took control unasked: the reason is "<email> took control",
  // and nobody asked for anything.
  const tookControl = human.human_in_control && !!human.reason?.endsWith(' took control');
  if (human.since) fields.push([tookControl ? 'since' : 'asked', formatWhen(human.since, now)]);
  if (human.waiting && human.expires_at) {
    fields.push(['ends', `${formatWhen(human.expires_at, now)} unless they hand it back`]);
  }

  if (human.handed_back && human.handed_back_at) {
    fields.push(['handed back', formatWhen(human.handed_back_at, now)]);
  }

  if (human.handed_back) {
    fields.push(['note', human.note ? printable(human.note, { oneLine: true }) : colors.dim('none')]);
  }
  return fields;
}
