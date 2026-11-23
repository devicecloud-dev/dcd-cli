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

import type { AuthContext } from '../types/domain/auth.types.js';
import { checkApiUrl } from '../utils/api-url.js';
import { getCliVersion, getInstallMethod } from '../utils/cli.js';
import type { EncryptionSource } from '../utils/envelope.js';

export type TelemetryLevel = 'log' | 'info' | 'warn' | 'error';

interface TelemetryEvent {
  timestamp: string;
  level: TelemetryLevel;
  context: string;
  message: string;
  extra?: Record<string, unknown>;
}

/** What a run encrypted, and what decided it (dcd#1138). */
export interface EncryptionTelemetry {
  binary: boolean;
  env: boolean;
  flow: boolean;
  source: EncryptionSource;
}

/**
 * Why a bundle download fell back to the inline endpoint. `manifest_unavailable`
 * (a 501) is the expected answer from a deployment without bundle delivery;
 * the rest are failures worth counting.
 */
export type BundleFallbackReason =
  | 'bundle_http_error'
  | 'bundle_request_failed'
  | 'bundle_stream_failed'
  /** The stream ended cleanly but the ZIP has no complete central directory. */
  | 'bundle_truncated'
  | 'manifest_http_error'
  | 'manifest_incomplete'
  | 'manifest_invalid_json'
  | 'manifest_request_failed'
  | 'manifest_unavailable';

export interface BundleFallbackTelemetry {
  /** Bytes of the ZIP received before the stream failed. */
  bytes_received?: number;
  duration_ms: number;
  /** Low-level error code from the cause, e.g. `ECONNRESET`. */
  error_code?: string;
  error_message?: string;
  error_name?: string;
  reason: BundleFallbackReason;
  /** The manifest route, e.g. `artifacts-bundle`. */
  route: string;
  /** HTTP status, for the `*_http_error` / `manifest_unavailable` reasons. */
  status?: number;
  upload_id?: string;
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
  private encryption: EncryptionTelemetry | null = null;
  private submitAttempts: number | undefined;
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
   *
   * Events go where the command's requests go: the `--api-url` flag first,
   * then `opts.apiUrl` (a login's stored API). Taking the login's API first
   * sent events from a command aimed at another API (a local one, or dev) to
   * that login's API instead.
   */
  configure(opts: { auth: AuthContext; apiUrl?: string }) {
    if (this.disabled) return;
    this.config = {
      apiUrl: argvApiUrl() ?? opts.apiUrl ?? DEFAULT_API_URL,
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

  recordMcpToolSuccess(
    tool: string,
    durationMs: number,
    extra: Record<string, unknown> = {},
  ) {
    this.enqueue('info', 'cli.mcp', 'mcp tool completed', {
      tool,
      duration_ms: durationMs,
      ...extra,
    });
  }

  recordMcpToolFailure(
    tool: string,
    error: unknown,
    durationMs: number,
    extra: Record<string, unknown> = {},
  ) {
    this.enqueue('error', 'cli.mcp', 'mcp tool failed', {
      tool,
      duration_ms: durationMs,
      error_message: redactUrls(error instanceof Error ? error.message : String(error)),
      error_name: error instanceof Error ? error.name : 'Error',
      ...extra,
    });
  }

  /**
   * Record what this command encrypts (dcd#1138), sent as `encrypt` on its
   * `command completed` / `command failed` event. Merged into what is already
   * recorded, so a command can fill each part in as it happens. On the event
   * rather than in `meta`, because the API's `/cli/logs` proxy forwards only
   * the meta fields it knows, but forwards every event's `extra`.
   */
  recordEncryption(update: Partial<EncryptionTelemetry>) {
    this.encryption = {
      binary: false,
      env: false,
      flow: false,
      source: 'off',
      ...this.encryption,
      ...update,
    };
  }

  /**
   * Record how many attempts the flow submit took (dcd#1617 follow-up), sent
   * as `submit_attempts` on `command completed` / `command failed`. Anything
   * above 1 means a response was lost and the submit was sent again, which is
   * what to count when judging how often the API stalls under the CLI.
   */
  recordSubmitAttempts(attempts: number) {
    this.submitAttempts = attempts;
  }

  /**
   * Record that a bundle download fell back to the inline endpoint, and why.
   * The user never sees the fallback (the inline download still delivers the
   * file), so without this the reason is lost.
   */
  recordBundleFallback(detail: BundleFallbackTelemetry) {
    this.enqueue(
      detail.reason === 'manifest_unavailable' ? 'info' : 'warn',
      'cli.download',
      'bundle download fell back',
      { ...detail },
    );
  }

  /**
   * Record an inline ZIP download that ended before its central directory.
   * The user sees the failure; this keeps a count of how often it happens.
   */
  recordDownloadIncomplete(detail: {
    bytes: number;
    /** The inline route, e.g. `download` or `html-report`. */
    route: string;
    upload_id?: string;
  }) {
    this.enqueue('warn', 'cli.download', 'download incomplete', { ...detail });
  }

  recordCommandSuccess() {
    this.enqueue('info', 'cli.lifecycle', 'command completed', {
      duration_ms: Date.now() - this.startedAt,
      exit_code: 0,
      ...this.encryptionExtra(),
      ...this.submitExtra(),
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
      // A failed install from a signed link says the link.
      error_message: redactUrls(message),
      error_name:
        opts.error instanceof Error ? opts.error.name : 'CliError',
      error_stack:
        opts.error instanceof Error && opts.error.stack ? redactUrls(opts.error.stack) : undefined,
      ...this.encryptionExtra(),
      ...this.submitExtra(),
    });
  }

  private encryptionExtra(): { encrypt?: EncryptionTelemetry } {
    return this.encryption ? { encrypt: this.encryption } : {};
  }

  private submitExtra(): { submit_attempts?: number } {
    return this.submitAttempts === undefined
      ? {}
      : { submit_attempts: this.submitAttempts };
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

const REDACTED = '<redacted>';

/**
 * Links in `text` without their query, fragment and user info. A signed
 * download link's query is its credential (`?X-Amz-Signature=…`), and `dcd
 * device start --app <url>` and `install <url>` take one as a plain value.
 * Where the link points stays, for telling failures apart.
 */
export function redactUrls(text: string): string {
  return text.replaceAll(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*@)?([^\s?#]*)(\?[^\s#]*)?(#\S*)?/gi,
    (_match, scheme: string, user: string | undefined, rest: string, query: string | undefined, fragment: string | undefined) =>
      `${scheme}${user ? `${REDACTED}@` : ''}${rest}${query ? `?${REDACTED}` : ''}${fragment ? `#${REDACTED}` : ''}`,
  );
}

/**
 * The argv a command was run with, as telemetry may keep it: without the
 * values of the flags above, and without what two `dcd device` subcommands
 * are given that no flag name marks as a secret.
 *
 * - `device open-link` takes its link as a positional. A sign-in link is a
 *   credential, and `--sensitive` promises it is never shown, so everything
 *   after `open-link` that is not a flag is taken for the link, and the value
 *   of any flag but the API URL goes too. That costs the session id, and
 *   keeps a link too malformed to send from being kept either.
 * - `device type` takes `--text`, which is a password or a code as often as
 *   not. `device tap` has a `--text` as well, an element's label, and keeps it.
 *
 * The subcommand is found by its name anywhere after `device`, not as the
 * first positional: a flag's value in between must not hide it.
 */
export function scrubArgv(args: string[]): string[] {
  const device = args.indexOf('device');
  const subcommand = (name: string) => (device === -1 ? -1 : args.indexOf(name, device + 1));
  const openLink = subcommand('open-link');
  const type = subcommand('type');
  const keeps = (flag: string) => API_URL_FLAGS.includes(flag);

  const scrubbed: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const isFlag = arg.startsWith('-');
    const eqIndex = arg.indexOf('=');
    const flagName = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    const afterOpenLink = openLink !== -1 && i > openLink;
    const secretFlag =
      SENSITIVE_FLAG_NAMES.has(flagName) ||
      (type !== -1 && i > type && flagName === '--text') ||
      // `--anything=value` after open-link: no flag of the command needs its value kept.
      (afterOpenLink && eqIndex !== -1 && !keeps(flagName));
    if (isFlag && secretFlag) {
      if (eqIndex === -1) {
        scrubbed.push(arg);
        if (i + 1 < args.length) {
          scrubbed.push(REDACTED);
          i++;
        }
      } else {
        scrubbed.push(`${flagName}=${REDACTED}`);
      }
    } else if (afterOpenLink && !isFlag) {
      scrubbed.push(keeps(args[i - 1]) ? arg : REDACTED);
    } else {
      scrubbed.push(arg);
    }
  }
  return scrubbed.map((arg) => redactUrls(arg));
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

/** The `--api-url` this command was given, if it is one the command would use. */
function argvApiUrl(): string | undefined {
  const args = process.argv.slice(2);
  // Only a URL the command itself would send credentials to: these events
  // carry them too, and may be sent before the command checks its flag.
  const usable = (url: string) => (checkApiUrl(url.trim()).ok ? url.trim() : undefined);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const flag of API_URL_FLAGS) {
      if (arg === flag && args[i + 1]) return usable(args[i + 1]);
      if (arg.startsWith(`${flag}=`)) return usable(arg.slice(flag.length + 1));
    }
  }
  return undefined;
}

export const telemetry = new Telemetry();
