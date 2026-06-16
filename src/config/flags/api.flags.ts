import type { ArgsDef } from 'citty';

/**
 * API authentication and configuration flags
 */
export const apiFlags = {
  'api-key': {
    type: 'string',
    alias: ['apiKey'],
    description:
      'API key for devicecloud.dev (find this in the console UI). You can also set the DEVICE_CLOUD_API_KEY environment variable.',
  },
  'api-url': {
    type: 'string',
    alias: ['apiURL', 'apiUrl'],
    // No citty `default` here: commands resolve the effective URL via
    // resolveApiUrl() so a value stored by `dcd login` (e.g. dev/staging) is
    // honored instead of always defaulting to prod. See utils/config-store.ts.
    description: 'API base URL (defaults to the URL stored by `dcd login`, else prod)',
  },
} as const satisfies ArgsDef;
