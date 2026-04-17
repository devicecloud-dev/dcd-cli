import chalk = require('chalk');

/**
 * Centralized styling utilities for CLI output
 * Provides consistent, developer-friendly visual formatting
 */

/**
 * Status symbols with associated colors
 */
export const symbols = {
  cancelled: chalk.gray('⊘'),
  error: chalk.red('✗'),
  info: chalk.blue('ℹ'),
  pending: chalk.yellow('⏸'),
  queued: chalk.gray('⏳'),
  running: chalk.blue('▶'),
  success: chalk.green('✓'),
  unknown: chalk.gray('?'),
  warning: chalk.yellow('⚠'),
} as const;

/**
 * Color utility functions for semantic styling
 */
export const colors = {
  bold: chalk.bold,
  dim: chalk.gray,
  error: chalk.red,
  highlight: chalk.cyan,
  info: chalk.blue,
  success: chalk.green,
  url: chalk.cyan.underline,
  warning: chalk.yellow,
} as const;

/**
 * Dividers for visual separation
 */
export const dividers = {
  heavy: chalk.gray('═'.repeat(80)),
  light: chalk.gray('─'.repeat(80)),
  short: chalk.gray('─'.repeat(40)),
} as const;

/**
 * Format a status with appropriate symbol and color
 * @param status - The status string to format
 * @returns Formatted status string with color and symbol
 */
export function formatStatus(status: string): string {
  const statusUpper = status.toUpperCase();

  switch (statusUpper) {
    case 'PASSED': {
      return `${symbols.success} ${colors.success(status)}`;
    }

    case 'FAILED': {
      return `${symbols.error} ${colors.error(status)}`;
    }

    case 'RUNNING': {
      return `${symbols.running} ${colors.info(status)}`;
    }

    case 'PENDING': {
      return `${symbols.pending} ${colors.warning(status)}`;
    }

    case 'QUEUED': {
      return `${symbols.queued} ${colors.dim(status)}`;
    }

    case 'CANCELLED': {
      return `${symbols.cancelled} ${colors.dim(status)}`;
    }

    default: {
      return `${symbols.unknown} ${colors.dim(status)}`;
    }
  }
}

/**
 * Format a section header
 * @param title - The title of the section
 * @returns Formatted section header
 */
export function sectionHeader(title: string): string {
  return `\n${colors.bold(title)}\n${dividers.light}`;
}

/**
 * Format a key-value pair with optional icon
 * @param icon - Icon to display before the key
 * @param key - The key name
 * @param value - The value to display
 * @returns Formatted key-value string
 */
export function keyValue(icon: string, key: string, value: string): string {
  return `${icon} ${colors.dim(key + ':')} ${colors.highlight(value)}`;
}

/**
 * Format a list item
 * @param text - The text of the list item
 * @param prefix - The prefix character (default: '•')
 * @returns Formatted list item
 */
export function listItem(text: string, prefix: string = '•'): string {
  return `${colors.dim(prefix)} ${text}`;
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
    chalk.bold(`${summary.completed}/${summary.total}`),
    colors.success(`✓ ${summary.passed}`),
    colors.error(`✗ ${summary.failed}`),
    colors.info(`▶ ${summary.running}`),
    colors.warning(`⏸ ${summary.pending}`),
    colors.dim(`⏳ ${summary.queued}`),
  ];

  return parts.join(' │ ');
}

/**
 * Format a box with content
 * @param content - The content to display in the box
 * @returns Formatted box with borders
 */
export function box(content: string): string {
  const lines = content.split('\n');
  const maxLength = Math.max(...lines.map((l) => l.length));
  const top = chalk.gray('┌' + '─'.repeat(maxLength + 2) + '┐');
  const bottom = chalk.gray('└' + '─'.repeat(maxLength + 2) + '┘');
  const middle = lines
    .map((line) => chalk.gray('│ ') + line.padEnd(maxLength) + chalk.gray(' │'))
    .join('\n');

  return `${top}\n${middle}\n${bottom}`;
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
    // eslint-disable-next-line no-console
    console.log(line);
  });

  const keys = Object.keys(columns);
  const headers = keys.map((k) => columns[k].header ?? k);
  const stripAnsi = (s: string): string => s.replace(/\u001B\[[0-9;]*m/g, '');
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

  printLine(headers.map((h, i) => pad(chalk.bold(h), widths[i])).join('  '));
  printLine(widths.map((w) => chalk.gray('─'.repeat(w))).join('  '));
  for (const row of cells) {
    printLine(row.map((c, i) => pad(c, widths[i])).join('  '));
  }
}

/**
 * Generate console URL based on API URL
 * If a non-default API URL is used, prepends "dev." to the console subdomain
 * @param apiUrl - The API URL being used
 * @param uploadId - The upload ID
 * @param resultId - The result ID
 * @returns The appropriate console URL
 */
export function getConsoleUrl(apiUrl: string, uploadId: number | string, resultId: number | string): string {
  const DEFAULT_API_URL = 'https://api.devicecloud.dev';
  const isDefaultApi = apiUrl === DEFAULT_API_URL;

  const consoleSubdomain = isDefaultApi ? 'console' : 'dev.console';
  return `https://${consoleSubdomain}.devicecloud.dev/results?upload=${uploadId}&result=${resultId}`;
}
