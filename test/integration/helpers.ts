/**
 * Shared utilities for the CLI integration suites.
 *
 * The mock API (Prism mocking swagger.json behind an API-key shim — see
 * ../dcd/mock-api) is booted by scripts/test-runner.mjs before mocha starts,
 * with readiness polling and an isolated DCD_CONFIG_DIR. Tests therefore
 * assert the success path unconditionally: a dead or missing mock API must
 * fail the suite, never soften it.
 */
import { exec as execCallback } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

export const exec = promisify(execCallback);

/** Absolute path to the built CLI so tests can run with any cwd. */
export const CLI = path.resolve('dist/index.js');

export const MOCK_API_URL = process.env.MOCK_API_URL ?? 'http://localhost:3001';

/** One of the keys accepted by the mock API's auth shim. */
export const MOCK_API_KEY = 'test-api-key-123';

// TCP port 9 ("discard") is essentially never bound on dev or CI machines,
// so connections are refused immediately — simulates an unreachable API
// without depending on a magic unbound high port.
export const DEAD_API_URL = 'http://127.0.0.1:9';

export interface FailedExec {
  code: number;
  stdout: string;
  stderr: string;
  /** stderr if non-empty, otherwise stdout — wherever the CLI's error landed. */
  output: string;
}

/**
 * Run a command that must exit non-zero. Returns the captured output for
 * assertions; throws if the command unexpectedly succeeds. Replaces the
 * `expect.fail` inside try/catch pattern, which chai's own AssertionError
 * could satisfy.
 */
export async function runExpectingFailure(
  command: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<FailedExec> {
  try {
    await exec(command, { timeout: 15_000, ...opts });
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    const stdout = typeof e.stdout === 'string' ? e.stdout : '';
    const stderr = typeof e.stderr === 'string' ? e.stderr : '';
    return { code: e.code ?? -1, stdout, stderr, output: stderr || stdout };
  }

  throw new Error(
    `Expected command to exit non-zero but it succeeded: ${command}`,
  );
}
