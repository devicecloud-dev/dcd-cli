import type { ArgsDef } from 'citty';

/**
 * GitHub context flags — stored as gh_* metadata alongside the run
 */
export const githubFlags = {
  branch: {
    type: 'string',
    description: 'Git branch name for this run (stored as gh_branch metadata)',
  },
  'commit-sha': {
    type: 'string',
    description: 'Git commit SHA for this run (stored as gh_sha metadata)',
  },
  'repo-name': {
    type: 'string',
    description:
      'Repository in owner/repo format (stored as gh_repo metadata, e.g. "acme/my-app")',
  },
  'pr-number': {
    type: 'string',
    description:
      'Pull request number for this run (stored as gh_pr_number metadata)',
  },
  'pr-url': {
    type: 'string',
    description: 'Pull request URL for this run (stored as gh_pr_url metadata)',
  },
} as const satisfies ArgsDef;
