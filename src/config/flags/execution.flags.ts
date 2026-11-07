import type { ArgsDef } from 'citty';

/** The runner types offered in help text, error messages and the MCP schema. */
export const RUNNER_TYPE_OPTIONS = ['default', 'm4', 'm1', 'cpu1'] as const;

/**
 * Runner types that were removed but are still accepted, so scripts that pass
 * them keep working. gpu1 was removed on 9 November 2026 and the API runs it
 * on cpu1. Never offered anywhere a user picks from.
 */
export const RETIRED_RUNNER_TYPES = ['gpu1'] as const;

/**
 * Test execution and flow management flags
 */
export const executionFlags = {
  'cancel-previous': {
    type: 'boolean',
    default: false,
    description:
      'Cancel the still-queued tests of the previous run from the same CI context: the same repo and branch or PR (and check name, if one is set), read from the run metadata. Needs repo plus branch/PR metadata (--repo-name with --branch or --pr-number, or --metadata gh_repo=… with gh_branch=… or gh_pr_number=…); without it nothing is superseded. Tests already running are left to finish; cancelled tests are refunded at 75%.',
  },
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
  priority: {
    type: 'string',
    default: 'normal',
    description:
      'Run priority within your organization (options: low, normal, high). Reorders only your own queued runs across your concurrency pool, for every flow in this upload; it never moves them ahead of other customers. Runs queued longer than 6 hours are promoted first, so low runs are never starved. Retries keep the same priority.',
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
      '[experimental] The type of runner to use (options: default, m4, m1, cpu1) - note: anything other than default or cpu1 will incur premium pricing tiers. See https://docs.devicecloud.dev/configuration/runner-type for more information.',
  },
} as const satisfies ArgsDef;
