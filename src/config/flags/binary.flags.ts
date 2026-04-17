import type { ArgsDef } from 'citty';

/**
 * Binary upload and management flags
 */
export const binaryFlags = {
  'app-binary-id': {
    type: 'string',
    description:
      'The ID of the app binary previously uploaded to devicecloud.dev',
  },
  'app-file': {
    type: 'string',
    description: 'App binary to run your flows against',
    valueHint: 'path',
  },
  'app-url': {
    type: 'string',
    description:
      'Signed URL to an Expo iOS build (.tar.gz). The archive is downloaded and extracted automatically. Expo signed URLs expire after ~1 hour.',
  },
  'ignore-sha-check': {
    type: 'boolean',
    description:
      'Ignore the sha hash check and upload the binary regardless of whether it already exists (not recommended)',
  },
} as const satisfies ArgsDef;
