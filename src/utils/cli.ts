/**
 * Shared helpers for command files.
 * - Version lookup from package.json
 * - Enum validation for string flags (citty 0.1.6 has no native enum)
 * - Array coercion for repeatable flags with comma-separated values
 * - A minimal Logger mirroring the oclif Command log/warn/error shape so call
 *   sites ported from oclif keep working.
 */
import { colors } from './styling';

// Resolve version at runtime — avoids pulling package.json into the tsbuildinfo rootDir.
export function getCliVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export class CliError extends Error {
  constructor(message: string, public exitCode: number = 1) {
    super(message);
    this.name = 'CliError';
  }
}

export interface Logger {
  log(message: string): void;
  warn(message: string): void;
  error(message: Error | string, opts?: { exit?: number; json?: boolean }): never;
  exit(code?: number): never;
}

export const logger: Logger = {
  log(message: string): void {
    // eslint-disable-next-line no-console
    console.log(message);
  },
  warn(message: string): void {
    // eslint-disable-next-line no-console
    console.warn(colors.warning('⚠') + '  ' + message);
  },
  error(
    message: Error | string,
    opts: { exit?: number; json?: boolean } = {},
  ): never {
    const text = message instanceof Error ? message.message : message;
    if (opts.json) {
      // When --json is active, emit failures as JSON on stdout so that
      // scripts consuming the output never need to parse stderr too.
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ status: 'FAILED', error: text }, null, 2));
    } else {
      // The literal "Error:" prefix is important for tests and for grep-friendly
      // CI logs — it survives color stripping and matches /error/i assertions.
      // eslint-disable-next-line no-console
      console.error(colors.error('✗') + '  Error: ' + text);
    }
    process.exit(opts.exit ?? 1);
  },
  exit(code: number = 0): never {
    process.exit(code);
  },
};

/**
 * Validate that a string flag value is one of the allowed options.
 * Returns the value untouched on success; throws CliError otherwise.
 */
export function validateEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flagName: string,
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!allowed.includes(value as T)) {
    throw new CliError(
      `Invalid value for --${flagName}: "${value}". Expected one of: ${allowed.join(', ')}`,
    );
  }
  return value as T;
}

/**
 * Coerce a flag value (possibly a single string, array, or undefined) into a
 * flat string array. Comma-separated values inside each entry are split out.
 * Used for repeatable flags like --include-tags, --env, --metadata where citty
 * surfaces a string (single use) or string[] (repeated).
 */
export function coerceArray(
  value: string | string[] | undefined,
  split = true,
): string[] {
  if (value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  if (!split) return arr;
  return arr.flatMap((v) => v.split(','));
}

/**
 * Parse an integer flag. Returns undefined if the value is undefined/empty.
 * Throws CliError if the value is not a valid integer.
 */
export function parseIntFlag(
  value: string | undefined,
  flagName: string,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) {
    throw new CliError(`Invalid integer value for --${flagName}: "${value}"`);
  }
  return n;
}
