/**
 * Ships CLI lifecycle + error events to Axiom via the API's `/cli/logs`
 * proxy (forwards to `cli-dev` / `cli-prod`). The proxy authenticates with
 * the same `auth.headers` every other gateway uses (`x-app-api-key` or
 * `Authorization: Bearer ...` + `x-dcd-org`), so we never need the Axiom
 * token client-side.
 *
 * Two flush paths:
 * - `flush()` — async, used after `runMain` returns naturally
 * - `flushSync()` — sync via `curl`, used inside `logger.error` right before
 *   `process.exit` (no other way to send HTTP after exit is called)
 *
 * Opt out: `DCD_TELEMETRY_DISABLED=1` in the environment.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthContext } from '../types/domain/auth.types';
import { getCliVersion, getInstallMethod } from '../utils/cli';

export type TelemetryLevel = 'log' | 'info' | 'warn' | 'error';

interface TelemetryEvent {
  timestamp: string;
  level: TelemetryLevel;
  context: string;
  message: string;
  extra?: Record<string, unknown>;
}

interface TelemetryConfig {
  apiUrl: string;
  auth: AuthContext;
  command: string;
}

const DEFAULT_API_URL = 'https://api.devicecloud.dev';

class Telemetry {
  private buffer: TelemetryEvent[] = [];
  private config: TelemetryConfig | null = null;
  private command: string = inferCommandFromArgv();
  private sessionId: string = randomUUID();
  private startedAt: number = Date.now();
  private readonly disabled: boolean = !!process.env.DCD_TELEMETRY_DISABLED;
  private readonly release: string = getCliVersion();

  /**
   * Called once per invocation by `resolveAuth` after the credential check
   * succeeds. Before this is called, lifecycle events are buffered but cannot
   * be sent. Commands that never reach `resolveAuth` (`--help`, `--version`,
   * `dcd login` before sign-in completes) will skip telemetry entirely — by
   * design, since those flows have no identity to attach.
   */
  configure(opts: { auth: AuthContext; apiUrl?: string }) {
    if (this.disabled) return;
    this.config = {
      apiUrl: opts.apiUrl ?? inferApiUrlFromArgv(),
      auth: opts.auth,
      command: this.command,
    };
  }

  /**
   * Override the command label attached to telemetry meta. The MCP server is
   * long-lived and isn't a citty subcommand, so `inferCommandFromArgv` can't
   * name it — `src/mcp/index.ts` calls this at boot.
   */
  setCommand(command: string) {
    this.command = command;
  }

  recordCommandStart() {
    this.startedAt = Date.now();
    this.enqueue('info', 'cli.lifecycle', 'command started', {
      argv: scrubArgv(process.argv.slice(2)),
    });
  }

  recordMcpToolStart(tool: string) {
    this.enqueue('info', 'cli.mcp', 'mcp tool invoked', { tool });
  }

  recordMcpToolSuccess(tool: string, durationMs: number) {
    this.enqueue('info', 'cli.mcp', 'mcp tool completed', {
      tool,
      duration_ms: durationMs,
    });
  }

  recordMcpToolFailure(tool: string, error: unknown, durationMs: number) {
    this.enqueue('error', 'cli.mcp', 'mcp tool failed', {
      tool,
      duration_ms: durationMs,
      error_message: error instanceof Error ? error.message : String(error),
      error_name: error instanceof Error ? error.name : 'Error',
    });
  }

  recordCommandSuccess() {
    this.enqueue('info', 'cli.lifecycle', 'command completed', {
      duration_ms: Date.now() - this.startedAt,
      exit_code: 0,
    });
  }

  recordCommandFailure(opts: {
    error: Error | string;
    exitCode: number;
  }) {
    const message =
      opts.error instanceof Error ? opts.error.message : String(opts.error);
    this.enqueue('error', 'cli.lifecycle', 'command failed', {
      duration_ms: Date.now() - this.startedAt,
      exit_code: opts.exitCode,
      error_message: message,
      error_name:
        opts.error instanceof Error ? opts.error.name : 'CliError',
      error_stack:
        opts.error instanceof Error ? opts.error.stack : undefined,
    });
  }

  private enqueue(
    level: TelemetryLevel,
    context: string,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    if (this.disabled) return;
    this.buffer.push({
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      extra,
    });
  }

  async flush(): Promise<void> {
    if (this.disabled || !this.config || this.buffer.length === 0) return;
    const events = this.buffer.splice(0, this.buffer.length);
    const body = JSON.stringify({ events, meta: this.buildMeta() });
    try {
      await fetch(`${this.config.apiUrl}/cli/logs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.config.auth.headers,
        },
        body,
      });
    } catch {
      // Telemetry failures must never surface — silently drop.
    }
  }

  /**
   * Synchronous flush via `curl`. Used right before `process.exit` (which
   * bypasses `beforeExit`, so async `fetch` would be killed mid-flight).
   * Node has no built-in sync HTTP and `curl` ships with macOS, Linux, and
   * Windows ≥ 1803 — that's the supported surface for the CLI.
   */
  flushSync(): void {
    if (this.disabled || !this.config || this.buffer.length === 0) return;
    const events = this.buffer.splice(0, this.buffer.length);
    const body = JSON.stringify({ events, meta: this.buildMeta() });
    // Headers carry the API key / Bearer token, so they must not appear in
    // curl's argv (world-readable via ps//proc while curl runs). They go in a
    // 0600 config file inside a fresh 0700 temp dir instead; stdin carries the
    // body, so it can't double as the config channel.
    let configDir: string | undefined;
    try {
      configDir = mkdtempSync(join(tmpdir(), 'dcd-telemetry-'));
      const configPath = join(configDir, 'curl.cfg');
      const headerLines = ['header = "content-type: application/json"'];
      for (const [k, v] of Object.entries(this.config.auth.headers)) {
        headerLines.push(`header = "${k}: ${v}"`);
      }
      writeFileSync(configPath, headerLines.join('\n'), { mode: 0o600 });
      execFileSync(
        'curl',
        [
          '-sS',
          '-m',
          '3',
          '-X',
          'POST',
          '-K',
          configPath,
          '--data-binary',
          '@-',
          `${this.config.apiUrl}/cli/logs`,
        ],
        { input: body, stdio: ['pipe', 'ignore', 'ignore'] },
      );
    } catch {
      // Telemetry failures must never surface — silently drop.
    } finally {
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    }
  }

  private buildMeta() {
    if (!this.config) {
      throw new Error('telemetry not configured');
    }
    return {
      release: this.release,
      command: this.command,
      sessionId: this.sessionId,
      authMode: this.config.auth.mode,
      installMethod: getInstallMethod(),
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userEmail: this.config.auth.userEmail,
      orgId: this.config.auth.orgId,
    };
  }
}

// Flags whose values are credential material (API keys, signed URLs) or
// user-provided env pairs that routinely carry test-account secrets. Their
// values must never reach the telemetry backend.
const SENSITIVE_FLAG_NAMES = new Set([
  '--api-key',
  '--apiKey',
  '--moropo-v1-api-key',
  '--app-url',
  '--appUrl',
  '-e',
  '--env',
]);

function scrubArgv(args: string[]): string[] {
  const scrubbed: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eqIndex = arg.indexOf('=');
    const flagName = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    if (arg.startsWith('-') && SENSITIVE_FLAG_NAMES.has(flagName)) {
      if (eqIndex === -1) {
        scrubbed.push(arg);
        if (i + 1 < args.length) {
          scrubbed.push('<redacted>');
          i++;
        }
      } else {
        scrubbed.push(`${flagName}=<redacted>`);
      }
    } else {
      scrubbed.push(arg);
    }
  }
  return scrubbed;
}

// argv layout: node|tsx, script, command, ...flags. The first non-flag after
// the script is the subcommand. Falls back to 'help' for `--help`/`--version`
// invocations and to 'unknown' if we can't decide.
function inferCommandFromArgv(): string {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    return arg;
  }
  if (args.some((a) => a === '--help' || a === '-h')) return 'help';
  if (args.some((a) => a === '--version' || a === '-v')) return 'version';
  return 'unknown';
}

const API_URL_FLAGS = ['--api-url', '--apiURL', '--apiUrl'];

function inferApiUrlFromArgv(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const flag of API_URL_FLAGS) {
      if (arg === flag && args[i + 1]) return args[i + 1];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  }
  return DEFAULT_API_URL;
}

export const telemetry = new Telemetry();
