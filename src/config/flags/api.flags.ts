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
    default: 'https://api.devicecloud.dev',
    description: 'API base URL',
  },
} as const satisfies ArgsDef;
