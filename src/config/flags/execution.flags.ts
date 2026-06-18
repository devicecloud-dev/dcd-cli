import type { ArgsDef } from 'citty';

/**
 * Test execution and flow management flags
 */
export const executionFlags = {
  config: {
    type: 'string',
    description:
      'Path to custom config.yaml file. If not provided, defaults to config.yaml in root flows folders.',
    valueHint: 'path',
  },
  'exclude-flows': {
    type: 'string',
    description:
      'Sub directories to ignore when building the flow file list (comma-separated, may be repeated)',
  },
  'exclude-tags': {
    type: 'string',
    description:
      'Flows which have these tags will be excluded from the run (comma-separated, may be repeated)',
  },
  flows: {
    type: 'string',
    description: 'The path to the flow file or folder containing your flows',
  },
  'include-tags': {
    type: 'string',
    description:
      'Only flows which have these tags will be included in the run (comma-separated, may be repeated)',
  },
  'maestro-version': {
    type: 'string',
    alias: ['maestroVersion'],
    description:
      'Maestro version to run your flow against. Use "latest" for the most recent version. See https://docs.devicecloud.dev/configuration/maestro-versions for supported versions.',
  },
  retry: {
    type: 'string',
    description:
      'Automatically retry the run up to the number of times specified (same as pressing retry in the UI) - this is free of charge',
  },
  'runner-type': {
    type: 'string',
    default: 'default',
    description:
      '[experimental] The type of runner to use (options: default, m4, m1, gpu1, cpu1) - note: anything other than default or cpu1 will incur premium pricing tiers, see https://docs.devicecloud.dev/configuration/runner-type for more information.',
  },
} as const satisfies ArgsDef;
