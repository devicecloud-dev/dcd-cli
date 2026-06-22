/**
 * Unified rendering layer for all CLI command output.
 *
 * Every command composes its output from these helpers so the look stays
 * consistent — a tree of `⏺` section headings with `⎿` branch groups of detail
 * rows beneath them, inspired by Claude Code. See STYLE_GUIDE.md for the rules
 * and worked examples.
 *
 * Functions RETURN strings (never write to stdout themselves) so callers route
 * them through their own logger / `--json` gate and they stay unit-testable.
 */
import {
  colors,
  formatStatus,
  glyphs,
  sectionHeader,
  statusPalette,
  stripAnsi,
  symbols,
} from './styling';

/**
 * Indentation under a section. The branch glyph sits two columns in and its
 * content begins at column four; continuation rows align to the same column.
 *
 *   ⏺ Title
 *     ⎿ first detail row
 *       continuation row
 */
const BRANCH_PREFIX = `  ${colors.dim(glyphs.branch)} `;
const CONTINUATION_PREFIX = '    ';

/** A `[label, value]` detail row; the value is passed through already styled. */
export type Field = [label: string, value: string];

export const ui = {
  /**
   * Render detail rows as a branch group beneath the most recent section:
   *
   *   ⎿ row one
   *     row two
   *
   * Embedded newlines in a row are kept aligned. Returns `''` for no rows.
   */
  branch(rows: string[]): string {
    const lines = rows.flatMap((row) => row.split('\n'));
    if (lines.length === 0) {
      return '';
    }

    return lines
      .map((line, index) =>
        index === 0 ? `${BRANCH_PREFIX}${line}` : `${CONTINUATION_PREFIX}${line}`,
      )
      .join('\n');
  },

  /**
   * Align `[label, value]` pairs into `label   value` rows for use inside a
   * {@link branch} group. Plain labels are dimmed; labels the caller already
   * styled (e.g. `colors.bold(name)`) are left as-is. Padding is measured on
   * visible width so ANSI colours never throw the columns off.
   */
  fields(pairs: Field[]): string[] {
    const width = Math.max(0, ...pairs.map(([label]) => stripAnsi(label).length));
    return pairs.map(([label, value]) => {
      const styled = stripAnsi(label) === label ? colors.dim(label) : label;
      const padding = ' '.repeat(Math.max(0, width - stripAnsi(label).length));
      return `${styled}${padding}   ${value}`;
    });
  },

  /** `ℹ message` — neutral, standalone information. */
  info(message: string): string {
    return `${symbols.info} ${message}`;
  },

  /** Dimmed secondary text — hints, tips, "you can close this terminal", etc. */
  note(message: string): string {
    return colors.dim(message);
  },

  /** `▶ message` — an action currently in progress. */
  running(message: string): string {
    return `${symbols.running} ${message}`;
  },

  /**
   * A top-level section header — `⏺ Title`, preceded by a blank line. Detail
   * rows belong underneath via {@link branch}.
   */
  section(title: string): string {
    return sectionHeader(title);
  },

  /** A coloured status word + symbol, e.g. `✓ passed`. Delegates to the shared palette. */
  status(status: string): string {
    return formatStatus(status);
  },

  /** The coloured status symbol alone, e.g. green `✓`. */
  statusSymbol(status: string): string {
    return statusPalette(status).symbol;
  },

  /** The lowercased status word in its status colour, e.g. green `passed`. */
  statusWord(status: string): string {
    const { color } = statusPalette(status);
    return color(status.toLowerCase());
  },

  /** `✓ message` — a completed action; the message is emphasised. */
  success(message: string): string {
    return `${symbols.success} ${colors.bold(message)}`;
  },

  /** `⚠ message` — a non-fatal warning. */
  warn(message: string): string {
    return `${symbols.warning} ${message}`;
  },
} as const;
