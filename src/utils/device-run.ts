import type {
  DeviceCommandResult,
  DeviceFailedAt,
  DeviceFailureLocation,
  DeviceFlowResult,
} from '../types/domain/device-session.types.js';
import { printable } from './device-output.js';
import { colors } from './styling.js';
import { type Field, ui } from './ui.js';

/**
 * What `dcd device run` shows a person: one row per flow and a short summary.
 *
 * The API passes on the runner's report as text in `result.output` (a pass)
 * or `result.error` (a failure). For a directory that report is Maestro's
 * JSON: `{ success, device_id, total_flows, total_commands_executed,
 * results: [{ file, success, error, message }], env_vars, message }`. For one
 * flow it is the same without `results`. Newer APIs also send
 * `result.flows`, which is used when present, and turn a failure's `error`
 * into plain text that says which flows failed, where (`failed_at`), and how
 * to fix a flow sent without the files it uses. That text is preferred to
 * the runner's own. None of the runner's own fields (device_id, command
 * counts, env_vars) are shown.
 */
export interface RunReport {
  flows: DeviceFlowResult[];
  /** The runner's one-line summary, e.g. "Some flows failed to execute". */
  message: null | string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): null | string {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Text that is not a JSON document: the API's own wording of a failure. */
function plainText(value: string | undefined): null | string {
  const t = text(value);
  return t && !t.startsWith('{') ? t : null;
}

function location(value: unknown): DeviceFailureLocation | null {
  if (!isRecord(value) || typeof value.file !== 'string' || typeof value.line !== 'number') return null;
  return {
    call_chain: Array.isArray(value.call_chain) ? value.call_chain.filter((s): s is string => typeof s === 'string') : [],
    command: typeof value.command === 'string' ? value.command : null,
    file: value.file,
    line: value.line,
  };
}

function failedAt(raw: Record<string, unknown>): DeviceFailedAt {
  const one = location(raw.failed_at);
  if (one) return { failed_at: one };
  const many = Array.isArray(raw.failed_at_candidates) ? raw.failed_at_candidates.map(location) : [];
  return many.length > 1 && many.every(Boolean) ? { failed_at_candidates: many as DeviceFailureLocation[] } : {};
}

function toFlow(raw: Record<string, unknown>, file: null | string): DeviceFlowResult {
  const success = raw.success === true;
  return {
    file: text(raw.file) ?? file,
    success,
    // A failed flow's reason is in `error`; some reports only have `message`.
    error: text(raw.error) ?? (success ? null : text(raw.message)),
    ...failedAt(raw),
  };
}

/** The runner's JSON report in `body`, or null when it is not one. */
function parseRunnerJson(body: string | undefined): null | RunReport {
  if (!body || !body.trimStart().startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (Array.isArray(parsed.results)) {
    return {
      flows: parsed.results.filter((r) => isRecord(r)).map((r) => toFlow(r, null)),
      message: text(parsed.message),
    };
  }

  if (typeof parsed.success !== 'boolean') return null;
  // One flow: the report is that flow's result.
  return { flows: [toFlow(parsed, null)], message: text(parsed.message) };
}

/**
 * The flows a run reported, or null when the result carries no report the
 * CLI can read (plain text): then the text is shown as it came.
 */
export function parseRunReport(result: DeviceCommandResult): null | RunReport {
  if (Array.isArray(result.flows)) {
    return { flows: result.flows.map((f) => toFlow({ ...f }, null)), message: null };
  }

  const report = parseRunnerJson(result.error) ?? parseRunnerJson(result.output);
  if (!report || result.success || report.flows.length !== 1) return report;
  // One flow that failed: the API's wording says more than the runner's
  // (where it failed, and why a file it uses was missing).
  const [flow] = report.flows;
  return {
    ...report,
    flows: [
      {
        ...flow,
        error: plainText(result.error) ?? flow.error,
        ...(flow.failed_at || flow.failed_at_candidates ? {} : failedAt(result as unknown as Record<string, unknown>)),
      },
    ],
  };
}

/** `sub/check.yaml:5`, the command if known, and how the flow got there. */
export function describeLocation(where: DeviceFailedAt): null | string {
  const at = (l: DeviceFailureLocation) => `${l.file}:${l.line}`;
  if (where.failed_at) {
    const l = where.failed_at;
    const via = l.call_chain.slice(0, -1);
    return [
      `at ${at(l)}`,
      l.command ? `  ${printable(l.command, { oneLine: true })}` : '',
      via.length > 0 ? `  (via ${via.join(' → ')})` : '',
    ].join('');
  }

  if (where.failed_at_candidates) return `at one of ${where.failed_at_candidates.map(at).join(', ')}`;
  return null;
}

/** The text names the place already, as the API's wording of a failure does: "... (at login.yaml:7)". */
function mentions(error: null | string | undefined, where: DeviceFailedAt): boolean {
  const places = where.failed_at ? [where.failed_at] : (where.failed_at_candidates ?? []);
  return Boolean(error) && places.length > 0 && places.every((l) => error!.includes(`${l.file}:${l.line}`));
}

/** The failure message for a failed run: each failing flow and why. */
export function runFailureMessage(result: DeviceCommandResult, report: null | RunReport): string {
  // The API's own text names the failing flows and where they failed.
  const own = plainText(result.error);
  if (own) return own;
  if (!report) return result.error || 'The flow failed.';
  const failed = report.flows.filter((f) => !f.success);
  if (failed.length === 0) return report.message ?? 'The flow failed.';
  return failed
    .map((f) => {
      const where = describeLocation(f);
      return `${f.file ?? 'flow'}: ${f.error ?? 'failed'}${where ? ` (${where})` : ''}`;
    })
    .join('; ');
}

/**
 * Print a run's result for a person. `label` names a flow the report does not
 * (a single flow's report has no file name).
 */
export function printRunResult(
  log: (line: string) => void,
  passed: boolean,
  result: DeviceCommandResult,
  label: string,
): void {
  printOutcome(log, passed, result, label);
  // What the app showed after the failure: why an assertion missed.
  if (!passed && result.screen_text?.length) {
    log(ui.section('On screen after the failure'));
    log(ui.branch(result.screen_text.map((t) => `"${printable(t, { oneLine: true })}"`)));
  }
}

function printOutcome(
  log: (line: string) => void,
  passed: boolean,
  result: DeviceCommandResult,
  label: string,
): void {
  const report = parseRunReport(result);
  if (!report || report.flows.length === 0) {
    log(passed ? ui.success('Flow passed') : `${ui.statusSymbol('FAILED')} Flow failed`);
    const where = describeLocation(result);
    if (report) {
      if (report.message) log(ui.note(printable(report.message)));
      if (!passed && where) log(ui.note(where));
      return;
    }

    // Plain text, not a report the CLI can read: show it as it came.
    if (result.output) {
      log(ui.section('Output'));
      log(printable(result.output));
    }

    if (result.error) {
      log(ui.section('Error'));
      log(colors.error(printable(result.error)));
    }

    if (!passed && where && !mentions(result.error, result)) log(ui.note(where));
    return;
  }

  const { flows } = report;
  const failed = flows.filter((f) => !f.success).length;
  const total = flows.length;
  let summary: string;
  if (total === 1) summary = passed ? 'Flow passed' : 'Flow failed';
  else if (failed === 0) summary = `${total} flows passed`;
  else summary = `${failed} of ${total} flows failed`;
  log(passed && failed === 0 ? ui.success(summary) : `${ui.statusSymbol('FAILED')} ${summary}`);

  const rows: Field[] = flows.map((f) => [
    printable(f.file ?? label, { oneLine: true }),
    f.success
      ? ui.statusWord('PASSED')
      : `${ui.statusWord('FAILED')}${f.error ? `  ${colors.error(printable(f.error, { oneLine: true }))}` : ''}`,
  ]);
  log(ui.branch(ui.fields(rows)));
  for (const f of flows) {
    const where = f.success ? null : describeLocation(f);
    if (where && !mentions(f.error, f)) log(ui.note(`${printable(f.file ?? label, { oneLine: true })} failed ${where}`));
  }
}
