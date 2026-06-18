import type { ArgsDef } from 'citty';

/**
 * Output format and artifact download flags
 */
export const outputFlags = {
  'artifacts-path': {
    type: 'string',
    description:
      'Custom file path for downloaded artifacts (default: ./artifacts.zip). Requires --download-artifacts.',
  },
  'junit-path': {
    type: 'string',
    description:
      'Custom file path for downloaded JUnit report (requires --report junit, default: ./report.xml)',
  },
  'allure-path': {
    type: 'string',
    description:
      'Custom file path for downloaded Allure report (requires --report allure, default: ./report.html)',
  },
  'html-path': {
    type: 'string',
    description:
      'Custom file path for downloaded HTML report (requires --report html, default: ./report.html)',
  },
  async: {
    type: 'boolean',
    description:
      'Immediately return (exit code 0) from the command without waiting for the results of the run (useful for saving CI minutes)',
  },
  debug: {
    type: 'boolean',
    default: false,
    description: 'Enable detailed debug logging for troubleshooting issues',
  },
  'download-artifacts': {
    type: 'string',
    description:
      'Download a zip containing the logs, screenshots and videos for each result in this run (options: ALL, FAILED)',
  },
  'dry-run': {
    type: 'boolean',
    default: false,
    description:
      'Simulate the run without actually triggering the upload/test, useful for debugging workflow issues.',
  },
  json: {
    type: 'boolean',
    description:
      'Output results in JSON format. Exit codes: 0 on success, 2 if the test run fails, 1 on CLI/infrastructure errors',
  },
  'json-file': {
    type: 'boolean',
    description:
      'Write JSON output to a file. File will be called <upload_id>_dcd.json unless you supply the --json-file-name flag - note: exits with code 0 even if the test run fails (CLI/infrastructure errors still exit 1)',
  },
  'json-file-name': {
    type: 'string',
    description:
      'A custom name for the JSON file (can also include relative path). Requires --json-file.',
  },
  quiet: {
    type: 'boolean',
    alias: ['q'],
    default: false,
    description: "Quieter console output that won't provide progress updates",
  },
  report: {
    type: 'string',
    alias: ['format'],
    description:
      'Generate and download test reports in the specified format (options: allure, junit, html, html-detailed). Use "allure" for a complete HTML report.',
  },
} as const satisfies ArgsDef;
