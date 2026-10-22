/**
 * The dcd API's public `GET /cli-config`: runtime configuration the CLI used to
 * compile in, fetched from the API it talks to so that rotating any of it is an
 * env change on the API rather than a CLI release.
 *
 * - `supabase_publishable_key` (dcd#1112): see ./supabase-key.ts.
 * - `binary_kek_public_key` (dcd#1138): the newest KEK public key the API
 *   publishes for client-side envelope encryption, with the version the API
 *   unwraps it with. Absent when the API publishes none.
 *
 * Fetched once per process per API URL and kept in memory only. It is
 * deliberately not cached on disk: a stale Supabase key makes GoTrue answer a
 * refresh with a 4xx, which `resolveAuth` treats as a dead session and deletes
 * the user's login, and a stale KEK would wrap uploads the API can no longer
 * unwrap. A failed fetch is not cached, so the next call retries.
 */

const FETCH_TIMEOUT_MS = 10_000;

export interface CliConfig {
  supabase_url?: string;
  supabase_publishable_key?: string;
  binary_kek_public_key?: { version: number; key: string };
}

const cache = new Map<string, Promise<CliConfig>>();

/** `apiUrl` without trailing slashes, so `…/` and `…` share one cache entry. */
export function cliConfigUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/cli-config`;
}

async function fetchCliConfig(apiUrl: string): Promise<CliConfig> {
  const url = cliConfigUrl(apiUrl);
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Failed to fetch CLI config from ${url}: HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`CLI config from ${url} is not a JSON object`);
  }
  return body as CliConfig;
}

/** The API's CLI config. A failed fetch is not cached, so the next call retries. */
export function getCliConfig(apiUrl: string): Promise<CliConfig> {
  const key = cliConfigUrl(apiUrl);
  let pending = cache.get(key);
  if (!pending) {
    pending = fetchCliConfig(apiUrl);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

/** Test seam: forget fetched configs. */
export function resetCliConfigCache(): void {
  cache.clear();
}
