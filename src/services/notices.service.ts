import { ui } from '../utils/ui.js';
import { colors } from '../utils/styling.js';
import { compareSemver } from './version.service.js';

export type NoticeLevel = 'deprecation' | 'warn' | 'info' | 'marketing';

export interface NoticeMatchRule {
  field: string;
  op: 'present' | 'absent' | 'equals' | 'in' | 'not_in' | 'lt' | 'gt';
  value?: unknown;
}

export interface NoticeMatch {
  rules: NoticeMatchRule[];
}

/**
 * The client-facing notice shape returned by the API (embedded in the
 * compatibility response and from GET /notices). `match` is an optional display
 * gate the CLI evaluates locally against its own context (e.g. the selected iOS
 * version) — the API can't know those at fetch time.
 */
export interface Notice {
  id: string;
  slug: string | null;
  level: NoticeLevel;
  title: string;
  body: string;
  learnMoreUrl: string | null;
  dismissible: boolean;
  match: NoticeMatch | null;
}

/** Flat key/value context the `match` DSL is evaluated against. */
export type NoticeContext = Record<string, unknown>;

function isPresent(raw: unknown): boolean {
  return raw !== null && raw !== undefined && raw !== false && raw !== '';
}

function ruleMatches(rule: NoticeMatchRule, ctx: NoticeContext): boolean {
  const raw = ctx[rule.field];
  switch (rule.op) {
    case 'present':
      return isPresent(raw);
    case 'absent':
      return !isPresent(raw);
    case 'equals':
      return isPresent(raw) && String(raw) === String(rule.value);
    case 'in':
      return (
        isPresent(raw) &&
        Array.isArray(rule.value) &&
        rule.value.map(String).includes(String(raw))
      );
    case 'not_in':
      return (
        isPresent(raw) &&
        Array.isArray(rule.value) &&
        !rule.value.map(String).includes(String(raw))
      );
    case 'lt':
      return (
        isPresent(raw) &&
        rule.value != null &&
        compareSemver(String(raw), String(rule.value)) < 0
      );
    case 'gt':
      return (
        isPresent(raw) &&
        rule.value != null &&
        compareSemver(String(raw), String(rule.value)) > 0
      );
    default:
      return false;
  }
}

/** A null / empty match imposes no constraint; otherwise every rule must match (AND). */
export function matchesRules(
  match: NoticeMatch | null | undefined,
  ctx: NoticeContext,
): boolean {
  if (!match || !Array.isArray(match.rules) || match.rules.length === 0) {
    return true;
  }
  return match.rules.every((rule) => ruleMatches(rule, ctx));
}

export interface RenderNoticesOptions {
  out: (message: string) => void;
  warnOut: (message: string) => void;
}

/** Render a single notice with styling appropriate to its level. */
function renderNotice(notice: Notice, opts: RenderNoticesOptions): void {
  const rows = [notice.body];
  if (notice.learnMoreUrl) {
    rows.push(`${colors.dim('See:')} ${colors.url(notice.learnMoreUrl)}`);
  }

  switch (notice.level) {
    case 'deprecation':
    case 'warn':
      opts.warnOut(ui.warn(colors.bold(notice.title)));
      opts.warnOut(ui.branch(rows));
      break;
    case 'marketing':
      opts.out(ui.section(notice.title));
      opts.out(ui.branch(rows));
      break;
    case 'info':
    default:
      opts.out(ui.info(colors.bold(notice.title)));
      opts.out(ui.branch(rows));
      break;
  }
}

/**
 * Filter notices by their local-context `match` gate and render those that pass.
 * Returns the visible notices so a `--json` caller can include them in its
 * payload instead of printing. When `--json` is active, callers pass no-op
 * out/warnOut so nothing is printed but the list is still returned.
 */
export function renderNotices(
  notices: Notice[] | undefined,
  ctx: NoticeContext,
  opts: RenderNoticesOptions,
): Notice[] {
  if (!notices || notices.length === 0) return [];
  const visible = notices.filter((n) => matchesRules(n.match, ctx));
  for (const notice of visible) {
    renderNotice(notice, opts);
  }
  return visible;
}
