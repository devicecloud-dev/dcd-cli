/**
 * Per-env devicecloud.dev coordinates — single source of truth for the URLs
 * and Supabase credentials the CLI uses.
 *
 * **These `anonKey` values are public.** Supabase anon keys are JWTs designed
 * to be embedded in client code (web apps, mobile apps, CLIs). They only
 * grant whatever the project's RLS policies expose. Don't worry about seeing
 * them here — every Supabase-based product ships its anon key the same way.
 * https://supabase.com/docs/guides/api/api-keys
 */

export type DcdEnvName = 'dev' | 'prod';

export interface DcdEnvironment {
  apiUrl: string;
  frontendUrl: string;
  supabase: {
    url: string;
    projectRef: string;
    anonKey: string;
  };
}

export const ENVIRONMENTS: Record<DcdEnvName, DcdEnvironment> = {
  prod: {
    apiUrl: 'https://api.devicecloud.dev',
    frontendUrl: 'https://console.devicecloud.dev',
    supabase: {
      url: 'https://cloud.devicecloud.dev',
      projectRef: 'pgydnphbimetinsgfkbo',
      anonKey:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBneWRucGhiaW1ldGluc2dma2JvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDc1OTQzNDYsImV4cCI6MjAyMzE3MDM0Nn0.hAYOMFxxwX1exkQkY9xyQJGC_GhGnyogkj2N-kBkMI8',
    },
  },
  dev: {
    apiUrl: 'https://api.dev.devicecloud.dev',
    frontendUrl: 'https://dev.console.devicecloud.dev',
    supabase: {
      url: 'https://lbmsowehtjwnqlurpemb.supabase.co',
      projectRef: 'lbmsowehtjwnqlurpemb',
      anonKey:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxibXNvd2VodGp3bnFsdXJwZW1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDkyMTg0ODcsImV4cCI6MjAyNDc5NDQ4N30.zeLTMAuZ_WwYvGdeP0kdvL_Zrs-RQee5APPyxmWq7qQ',
    },
  },
};

/** Map a caller-supplied API URL to one of the known environments. */
export function inferEnvFromApiUrl(apiUrl: string): DcdEnvName {
  if (apiUrl.includes('api.dev.') || apiUrl.includes('localhost')) return 'dev';
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
