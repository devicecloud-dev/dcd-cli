import type { DeviceCommandResult, DeviceFlowResult } from '../types/domain/device-session.types.js';
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
 * `result.flows`, which is used when present. None of the runner's own
 * fields (device_id, command counts, env_vars) are shown.
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

function toFlow(raw: Record<string, unknown>, file: null | string): DeviceFlowResult {
  const success = raw.success === true;
  return {
    file: text(raw.file) ?? file,
    success,
    // A failed flow's reason is in `error`; some reports only have `message`.
    error: text(raw.error) ?? (success ? null : text(raw.message)),
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

  return parseRunnerJson(result.error) ?? parseRunnerJson(result.output);
}

/** The failure message for a failed run: each failing flow and why. */
export function runFailureMessage(result: DeviceCommandResult, report: null | RunReport): string {
  if (!report) return result.error || 'The flow failed.';
  const failed = report.flows.filter((f) => !f.success);
  if (failed.length === 0) return report.message ?? 'The flow failed.';
  return failed
    .map((f) => `${f.file ?? 'flow'}: ${f.error ?? 'failed'}`)
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
  const report = parseRunReport(result);
  if (!report || report.flows.length === 0) {
    log(passed ? ui.success('Flow passed') : `${ui.statusSymbol('FAILED')} Flow failed`);
    if (report) {
      if (report.message) log(ui.note(report.message));
      return;
    }

    // Plain text, not a report the CLI can read: show it as it came.
    if (result.output) {
      log(ui.section('Output'));
      log(result.output);
    }

    if (result.error) {
      log(ui.section('Error'));
      log(colors.error(result.error));
    }

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
    f.file ?? label,
    f.success
      ? ui.statusWord('PASSED')
      : `${ui.statusWord('FAILED')}${f.error ? `  ${colors.error(f.error)}` : ''}`,
  ]);
  log(ui.branch(ui.fields(rows)));
}
