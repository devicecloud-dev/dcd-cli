import type { ArgsDef } from 'citty';

/**
 * Environment configuration and metadata flags
 */
export const environmentFlags = {
  env: {
    type: 'string',
    alias: ['e'],
    description:
      'One or more environment variables to inject into your flows (format: KEY=VALUE, may be repeated)',
    valueHint: 'KEY=VALUE',
  },
  metadata: {
    type: 'string',
    alias: ['m'],
    description:
      'Arbitrary key-value metadata to include with your test run (format: key=value, may be repeated)',
  },
  'moropo-v1-api-key': {
    type: 'string',
    description: 'API key for Moropo v1 integration',
  },
  name: {
    type: 'string',
    description:
      'A custom name for your upload (useful for tagging commits etc)',
  },
} as const satisfies ArgsDef;
