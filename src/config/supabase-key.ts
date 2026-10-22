/**
 * The Supabase publishable key, fetched from the dcd API at runtime (dcd#1112).
 *
 * Releases up to this one compiled the anon key in, so the key could never be
 * rotated without breaking every CLI version pinned in customer CI. The API now
 * serves it from the public `GET /cli-config`, and rotating it is an env change
 * on the API.
 *
 * Fetched once per process and kept in memory only. It is deliberately not
 * cached on disk: a stale key makes GoTrue answer a refresh with a 4xx, which
 * `resolveAuth` treats as a dead session and deletes the user's login.
 *
 * Only the key comes from the API. The Supabase URLs stay pinned in
 * `ENVIRONMENTS`: prod goes through the `cloud.devicecloud.dev` custom domain,
 * which customer firewalls may allow-list, not the API's raw `supabase.co` URL.
 */
import { ENVIRONMENTS, type DcdEnvName } from './environments.js';

const FETCH_TIMEOUT_MS = 10_000;

const cache = new Map<DcdEnvName, Promise<string>>();

async function fetchSupabaseKey(env: DcdEnvName): Promise<string> {
  const url = `${ENVIRONMENTS[env].apiUrl}/cli-config`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Failed to fetch CLI config from ${url}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { supabase_publishable_key?: unknown };
  const key = body.supabase_publishable_key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`CLI config from ${url} has no supabase_publishable_key`);
  }
  return key;
}

/** The publishable key for `env`. A failed fetch is not cached, so the next call retries. */
export function getSupabaseKey(env: DcdEnvName): Promise<string> {
  let pending = cache.get(env);
  if (!pending) {
    pending = fetchSupabaseKey(env);
    cache.set(env, pending);
    pending.catch(() => cache.delete(env));
  }
  return pending;
}

/**
 * Headers that authenticate a raw Storage/Auth request with `key` alone. A
 * legacy anon key is a JWT and also goes in `Authorization`; an
 * `sb_publishable_` key is not a JWT and must only be sent as `apikey`.
 */
export function supabaseKeyHeaders(key: string): Record<string, string> {
  return key.startsWith('sb_') ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
}

/** Test seam: forget fetched keys. */
export function resetSupabaseKeyCache(): void {
  cache.clear();
}
