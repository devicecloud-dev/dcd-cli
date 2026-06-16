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
  mitmHost: {
    type: 'string',
    description:
      'used for mitmproxy support, enterprise only, contact support if interested',
  },
  mitmPath: {
    type: 'string',
    description:
      'used for mitmproxy support, enterprise only, contact support if interested',
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
