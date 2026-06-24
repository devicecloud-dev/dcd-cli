/**
 * Shared helpers for command files.
 * - Version lookup from package.json
 * - Enum validation for string flags (citty 0.1.6 has no native enum)
 * - Array coercion for repeatable flags with comma-separated values
 * - A minimal Logger mirroring the oclif Command log/warn/error shape so call
 *   sites ported from oclif keep working.
 */
import { readFileSync } from 'node:fs';

import { telemetry } from '../services/telemetry.service.js';

import { symbols } from './styling.js';

// Resolve version at runtime. The bun-compiled binary can't read package.json
// off disk (it isn't bundled next to the embedded module), so the build stamps
// the version in via `bun --define __DCD_CLI_VERSION__` (see
// scripts/build-binaries.mjs). Prefer that constant; on the npm/tsx path the
// identifier was never defined, so `typeof` is 'undefined' (no ReferenceError)
// and we fall back to reading package.json.
export function getCliVersion(): string {
  if (
    typeof __DCD_CLI_VERSION__ === 'string' &&
    __DCD_CLI_VERSION__.length > 0
  ) {
    return __DCD_CLI_VERSION__;
  }
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export type InstallMethod = 'binary' | 'npm';

// The Bun runtime sets process.versions.bun; bun-compiled standalone binaries
// inherit this. Node-run installs (npm/pnpm/npx/tsx) don't expose it.
export function getInstallMethod(): InstallMethod {
  return typeof (process.versions as { bun?: string }).bun === 'string'
    ? 'binary'
    : 'npm';
}

export function getUpgradeCommand(): string {
  return getInstallMethod() === 'binary'
    ? 'dcd upgrade'
    : 'npm install -g @devicecloud.dev/dcd@latest';
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
    console.warn(symbols.warning + ' ' + message);
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
      console.error(symbols.error + ' Error: ' + text);
    }
    // process.exit bypasses beforeExit, so async fetch in telemetry.flush()
    // would be killed mid-flight. flushSync uses curl to ship synchronously
    // before we exit; it's a no-op if telemetry never reached configure().
    const exitCode = opts.exit ?? 1;
    telemetry.recordCommandFailure({ error: message, exitCode });
    telemetry.flushSync();
    process.exit(exitCode);
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
 * Pair with {@link collectRepeatedFlag} for repeatable flags.
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
 * Collect every occurrence of a repeatable flag from raw argv, in order.
 *
 * citty 0.2.2 delegates to Node's `parseArgs`, which — without `multiple: true`
 * (unsupported by citty's ArgsDef) — keeps only the LAST value of a repeated
 * `type: 'string'` flag. So `-e A=1 -e B=2` collapses to just `B=2`. We recover
 * all occurrences by scanning rawArgs ourselves (same approach as
 * `recoverFlagValue` in commands/live.ts).
 *
 * `names` lists every spelling of one logical flag, e.g. ['--env', '-e'].
 * Handles both `--flag value` (consuming the next token, so values starting
 * with `-` survive) and `--flag=value`. Feed the result through
 * {@link coerceArray} for comma-splitting where appropriate.
 */
export function collectRepeatedFlag(
  rawArgs: string[],
  names: string[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    const eqName = names.find((n) => arg.startsWith(`${n}=`));
    if (eqName) {
      out.push(arg.slice(eqName.length + 1));
      continue;
    }
    if (names.includes(arg) && i + 1 < rawArgs.length) {
      out.push(rawArgs[i + 1]);
      i++; // consume the value so a leading-dash value isn't re-read as a flag
    }
  }
  return out;
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
  // All integer flags (limit/offset/retry) are non-negative; also rejects
  // trailing garbage that parseInt would silently accept ("20abc" -> 20).
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CliError(`Invalid integer value for --${flagName}: "${value}"`);
  }
  return Number.parseInt(trimmed, 10);
}
