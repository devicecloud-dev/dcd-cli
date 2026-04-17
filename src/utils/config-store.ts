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
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

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
    if (parsed.version !== CONFIG_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeConfig(config: StoredConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  }

  const finalPath = getConfigPath();
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
