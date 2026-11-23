import { styleText } from 'node:util';

import { findEnvByApiUrl } from '../config/environments.js';

/**
 * Centralized styling utilities for CLI output
 * Provides consistent, developer-friendly visual formatting
 *
 * Colours come from Node's `util.styleText`. Text is styled only when stdout
 * takes colour (see {@link takesColour}); text bound for stderr goes through
 * {@link forStderr}.
 */

/** Strip ANSI color escape sequences for visible-width calculations. */
// eslint-disable-next-line no-control-regex -- matches ANSI escape sequences
export const stripAnsi = (s: string): string => s.replace(/\u001B\[[0-9;]*m/g, '');

/**
 * Whether `stream` takes colour, by the rule Node's `styleText` applies:
 * `FORCE_COLOR` decides when set; otherwise the stream must be a terminal
 * whose colour depth (which folds in `NO_COLOR`, `NODE_DISABLE_COLORS` and
 * `TERM=dumb`) is above monochrome.
 *
 * Decided here rather than left to `styleText`'s own check because not every
 * runtime makes that check: bun 1.3, which compiles the standalone binaries,
 * and Node before 22.8 colour unconditionally.
 */
function takesColour(stream: NodeJS.WriteStream): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return ['', '1', '2', '3', 'true'].includes(force);
  return (
    stream.isTTY === true &&
    (typeof stream.getColorDepth !== 'function' || stream.getColorDepth() > 2)
  );
}

/**
 * One format at a time; combined styles nest single-format calls, which every
 * supported runtime handles alike, where an array of formats does not.
 */
type StyleFormat = Extract<Parameters<typeof styleText>[0], string>;

/**
 * Apply `format` to `text` when stdout takes colour. `styleText` throws on
 * anything but a string, so a value the types call a string but an API sent
 * as null or a number is printed, never fatal.
 */
function style(format: StyleFormat, text: string): string {
  const s = String(text);
  return takesColour(process.stdout) ? styleText(format, s, { validateStream: false }) : s;
}

const paint =
  (format: StyleFormat) =>
  (text: string): string =>
    style(format, text);

const cyan = paint('cyan');
const underline = paint('underline');

/**
 * Status symbols with associated colors
 */
export const symbols = {
  cancelled: style('gray', '⊘'),
  deprecation: style('red', '⚠'),
  error: style('red', '✗'),
  info: style('blue', 'ℹ'),
  pending: style('yellow', '⏸'),
  queued: style('gray', '⏳'),
  running: style('blue', '▶'),
  success: style('green', '✓'),
  unknown: style('gray', '?'),
  warning: style('yellow', '⚠'),
} as const;

/**
 * Color utility functions for semantic styling
 */
export const colors = {
  bold: paint('bold'),
  dim: paint('gray'),
  error: paint('red'),
  highlight: cyan,
  info: paint('blue'),
  success: paint('green'),
  url: (text: string): string => cyan(underline(text)),
  warning: paint('yellow'),
} as const;

/**
 * Prepare styled text for stderr. The palette above follows stdout, so when
 * stdout is a terminal but stderr is not (`dcd cloud 2> err.log`), the colour
 * codes are stripped here to keep the file plain.
 * @param text - Text that may carry colour codes from {@link colors} or {@link symbols}
 * @returns The text, without colour codes unless stderr takes colour
 */
export function forStderr(text: string): string {
  return takesColour(process.stderr) ? text : stripAnsi(text);
}

/**
 * Structural glyphs that give the CLI its tree-shaped layout. `section` marks a
 * top-level heading; `branch` opens the group of detail rows beneath it.
 * See STYLE_GUIDE.md.
 */
export const glyphs = {
  branch: '⎿',
  section: '⏺',
} as const;

/**
 * The single source of truth mapping a run/test status to its colour and
 * (already-coloured) symbol. Both {@link formatStatus} and the `ui` status
 * helpers build on this, so every status reads identically everywhere.
 * @param status - The status string (case-insensitive)
 */
export function statusPalette(status: string): {
  color: (s: string) => string;
  symbol: string;
} {
  switch (status.toUpperCase()) {
    case 'PASSED': {
      return { color: colors.success, symbol: symbols.success };
    }

    case 'ERROR':
    case 'FAILED': {
      return { color: colors.error, symbol: symbols.error };
    }

    case 'RUNNING': {
      return { color: colors.info, symbol: symbols.running };
    }

    case 'PENDING': {
      return { color: colors.warning, symbol: symbols.pending };
    }

    case 'QUEUED': {
      return { color: colors.dim, symbol: symbols.queued };
    }

    case 'CANCELLED': {
      return { color: colors.dim, symbol: symbols.cancelled };
    }

    default: {
      return { color: colors.dim, symbol: symbols.unknown };
    }
  }
}

/**
 * Format a status as a coloured symbol followed by the lowercased status word,
 * e.g. `✓ passed`.
 * @param status - The status string to format
 * @returns Formatted status string with color and symbol
 */
export function formatStatus(status: string): string {
  const { color, symbol } = statusPalette(status);
  return `${symbol} ${color(status.toLowerCase())}`;
}

/**
 * Format a top-level section header in the tree style: a `⏺` marker followed by
 * the bold title, preceded by a blank line for separation. Detail rows belong
 * underneath in a branch group (see the `ui` helpers).
 * @param title - The title of the section
 * @returns Formatted section header
 */
export function sectionHeader(title: string): string {
  return `\n${colors.dim(glyphs.section)} ${colors.bold(title)}`;
}

/**
 * Format a URL
 * @param url - The URL to format
 * @returns Formatted URL with styling
 */
export function formatUrl(url: string): string {
  return colors.url(url);
}

/**
 * Format an ID or identifier
 * @param id - The ID to format
 * @returns Formatted ID with highlighting
 */
export function formatId(id: string): string {
  return colors.highlight(id);
}

/**
 * Format a test summary line
 * @param summary - Object containing test counts
 * @returns Formatted summary string
 */
export function formatTestSummary(summary: {
  completed: number;
  failed: number;
  passed: number;
  pending: number;
  queued: number;
  running: number;
  total: number;
}): string {
  const parts = [
    colors.bold(`${summary.completed}/${summary.total}`),
    colors.success(`✓ ${summary.passed}`),
    colors.error(`✗ ${summary.failed}`),
    colors.info(`▶ ${summary.running}`),
    colors.warning(`⏸ ${summary.pending}`),
    colors.dim(`⏳ ${summary.queued}`),
  ];

  return parts.join(' │ ');
}

/**
 * Minimal column table renderer.
 * Columns are defined with a `get(row) => string` accessor and optional header label.
 * Matches the subset of oclif's ux.table used by this CLI.
 */
export function table<T>(
  rows: T[],
  columns: Record<string, { get: (row: T) => string; header?: string }>,
  options: { printLine?: (line: string) => void } = {},
): void {
  const printLine = options.printLine ?? ((line: string) => {
    console.log(line);
  });

  const keys = Object.keys(columns);
  const headers = keys.map((k) => columns[k].header ?? k);
  const cells: string[][] = rows.map((row) =>
    keys.map((k) => String(columns[k].get(row) ?? '')),
  );
  const widths = keys.map((_, i) =>
    Math.max(
      stripAnsi(headers[i]).length,
      ...cells.map((r) => stripAnsi(r[i]).length),
    ),
  );
  const pad = (s: string, width: number): string => {
    const visibleLen = stripAnsi(s).length;
    return s + ' '.repeat(Math.max(0, width - visibleLen));
  };

  printLine(headers.map((h, i) => pad(colors.bold(h), widths[i])).join('  '));
  printLine(widths.map((w) => colors.dim('─'.repeat(w))).join('  '));
  for (const row of cells) {
    printLine(row.map((c, i) => pad(c, widths[i])).join('  '));
  }
}

/**
 * Generate console URL based on API URL
 * Derives the console host from the known environment matching the API URL;
 * unknown API URLs fall back to the dev console (historical behavior).
 * @param apiUrl - The API URL being used
 * @param uploadId - The upload ID
 * @param resultId - The result ID
 * @returns The appropriate console URL
 */
export function getConsoleUrl(apiUrl: string, uploadId: number | string, resultId: number | string): string {
  const env = findEnvByApiUrl(apiUrl);
  const base = env?.frontendUrl ?? 'https://dev.console.devicecloud.dev';
  return `${base}/results?upload=${uploadId}&result=${resultId}`;
}
