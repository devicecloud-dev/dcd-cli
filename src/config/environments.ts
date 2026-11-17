/**
 * Per-env devicecloud.dev coordinates — single source of truth for the URLs
 * the CLI uses.
 *
 * There is deliberately no Supabase key and no KEK public key here. A
 * compiled-in key can never be rotated without breaking every pinned CLI
 * version, so both are fetched from the API at runtime instead: see
 * ./cli-config.ts (`getSupabaseKey` in ./supabase-key.ts for dcd#1112, and
 * `resolveKekPublicKey` in ../utils/envelope.ts for dcd#1138).
 */

export type DcdEnvName = 'dev' | 'prod';

export interface DcdEnvironment {
  apiUrl: string;
  /**
   * Older API URLs that still reach this environment. A config saved by an
   * earlier `dcd login`, or a `--api-url` in someone's CI, may still name one,
   * so it must keep resolving to this environment.
   */
  legacyApiUrls?: string[];
  frontendUrl: string;
  supabase: {
    url: string;
    projectRef: string;
  };
}

export const ENVIRONMENTS: Record<DcdEnvName, DcdEnvironment> = {
  prod: {
    apiUrl: 'https://api.devicecloud.dev',
    frontendUrl: 'https://console.devicecloud.dev',
    supabase: {
      url: 'https://cloud.devicecloud.dev',
      projectRef: 'pgydnphbimetinsgfkbo',
    },
  },
  dev: {
    apiUrl: 'https://dev-api.devicecloud.dev',
    legacyApiUrls: ['https://api.dev.devicecloud.dev'],
    frontendUrl: 'https://dev.console.devicecloud.dev',
    supabase: {
      url: 'https://lbmsowehtjwnqlurpemb.supabase.co',
      projectRef: 'lbmsowehtjwnqlurpemb',
    },
  },
};

/**
 * Exact-match lookup of a known environment by API URL, current or legacy
 * (trailing slashes ignored).
 */
export function findEnvByApiUrl(apiUrl: string): DcdEnvironment | undefined {
  const normalize = (u: string) => u.replace(/\/+$/, '');
  const needle = normalize(apiUrl);
  return Object.values(ENVIRONMENTS).find((env) =>
    [env.apiUrl, ...(env.legacyApiUrls ?? [])].some((u) => normalize(u) === needle),
  );
}

/**
 * Map a caller-supplied API URL to one of the known environments. This picks
 * the Supabase project uploads go to, so a dev URL must never fall through to
 * prod: both dev hostnames (`dev-api.` and the older `api.dev.`) and
 * localhost are dev.
 */
export function inferEnvFromApiUrl(apiUrl: string): DcdEnvName {
  if (
    apiUrl.includes('dev-api.') ||
    apiUrl.includes('api.dev.') ||
    apiUrl.includes('localhost')
  ) {
    return 'dev';
  }
  return 'prod';
}

/**
 * Frontend URL to open for a given API URL. Same as
 * `ENVIRONMENTS[inferEnvFromApiUrl(apiUrl)].frontendUrl`, except that when the
 * API is running on localhost we assume the frontend is too (vite dev server).
 */
export function resolveFrontendUrl(apiUrl: string): string {
  if (apiUrl.includes('localhost')) return 'http://localhost:5173';
  return ENVIRONMENTS[inferEnvFromApiUrl(apiUrl)].frontendUrl;
}
