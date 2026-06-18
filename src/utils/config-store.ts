/**
 * Persistent CLI config: Supabase session tokens + chosen org.
 *
 * Storage: $XDG_CONFIG_HOME/dcd/config.json (fallback ~/.dcd/config.json).
 * File mode 0600, directory mode 0700 — owner-only.
 * Writes are atomic (tmp file + rename) so a crash mid-refresh can't
 * leave a corrupt config behind that logs the user out.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { ENVIRONMENTS } from '../config/environments';

export const CONFIG_SCHEMA_VERSION = 1;

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  /** Unix epoch seconds. */
  expires_at: number;
  user_email: string;
  user_id: string;
}

export interface StoredConfig {
  version: number;
  env: 'dev' | 'prod';
  api_url: string;
  supabase_url: string;
  session?: StoredSession;
  current_org_id?: string;
  current_org_name?: string;
}

export function getConfigDir(): string {
  if (process.env.DCD_CONFIG_DIR) return process.env.DCD_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) return path.join(xdg, 'dcd');
  return path.join(homedir(), '.dcd');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function readConfig(): StoredConfig | null {
  const p = getConfigPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as StoredConfig;
    if (parsed.version !== CONFIG_SCHEMA_VERSION) {
      // eslint-disable-next-line no-console
      console.warn(
        `Warning: config at ${p} was written by an incompatible CLI version (config version ${parsed.version}); ignoring it. Run \`dcd login\` to recreate it.`,
      );
      return null;
    }
    return parsed;
  } catch {
    // Surface the corruption instead of silently behaving as logged-out, so
    // downstream "Not authenticated" errors aren't mystifying.
    // eslint-disable-next-line no-console
    console.warn(
      `Warning: could not parse config at ${p}; treating as logged out. Run \`dcd login\` to recreate it.`,
    );
    return null;
  }
}

/**
 * Resolve the API URL a command should talk to. Precedence:
 *   1. explicit --api-url flag
 *   2. api_url stored by `dcd login` (honors the env the user logged into)
 *   3. prod default
 *
 * Without this, session commands default to prod and a dev/staging Bearer
 * token is rejected with a misleading "Invalid or expired JWT". `switch-org`
 * has always done this; this helper extends it to every command.
 */
export function resolveApiUrl(flag: string | undefined): string {
  const explicit = flag?.trim();
  if (explicit) return explicit;
  return readConfig()?.api_url ?? ENVIRONMENTS.prod.apiUrl;
}

export function writeConfig(config: StoredConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  }

  const finalPath = getConfigPath();

  // Best-effort cleanup of orphaned tmp files left behind by crashed writes.
  // Only remove old ones — a concurrent process may be between its own
  // writeFileSync and renameSync right now.
  try {
    const base = path.basename(finalPath);
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(`${base}.`) || !entry.endsWith('.tmp')) continue;
      const tmp = path.join(dir, entry);
      try {
        if (Date.now() - statSync(tmp).mtimeMs > 60_000) unlinkSync(tmp);
      } catch { /* best effort */ }
    }
  } catch { /* best effort */ }

  const tmpPath = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { chmodSync(tmpPath, 0o600); } catch { /* best effort on platforms w/o chmod */ }
  renameSync(tmpPath, finalPath);
  try { chmodSync(finalPath, 0o600); } catch { /* best effort */ }
}

export function clearConfig(): void {
  const p = getConfigPath();
  if (existsSync(p)) unlinkSync(p);
}

export function configFileMode(): number | null {
  const p = getConfigPath();
  if (!existsSync(p)) return null;
  return statSync(p).mode & 0o777;
}
