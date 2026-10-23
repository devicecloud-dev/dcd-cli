/**
 * The Supabase publishable key, fetched from the dcd API at runtime (dcd#1112).
 *
 * Releases up to this one compiled the anon key in, so the key could never be
 * rotated without breaking every CLI version pinned in customer CI. The API now
 * serves it from the public `GET /cli-config` (see ./cli-config.ts for the
 * fetch and its in-memory cache), and rotating it is an env change on the API.
 *
 * Only the key comes from the API. The Supabase URLs stay pinned in
 * `ENVIRONMENTS`: prod goes through the `cloud.devicecloud.dev` custom domain,
 * which customer firewalls may allow-list, not the API's raw `supabase.co` URL.
 */
import { cliConfigUrl, getCliConfig, resetCliConfigCache } from './cli-config.js';
import { ENVIRONMENTS, type DcdEnvName } from './environments.js';

/** The publishable key for `env`. A failed fetch is not cached, so the next call retries. */
export async function getSupabaseKey(env: DcdEnvName): Promise<string> {
  const apiUrl = ENVIRONMENTS[env].apiUrl;
  const key = (await getCliConfig(apiUrl)).supabase_publishable_key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`CLI config from ${cliConfigUrl(apiUrl)} has no supabase_publishable_key`);
  }
  return key;
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
  resetCliConfigCache();
}
