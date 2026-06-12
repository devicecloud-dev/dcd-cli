import { defineCommand } from 'citty';

import { apiFlags } from '../config/flags/api.flags';
import { ApiGateway } from '../gateways/api-gateway';
import { resolveAuth } from '../utils/auth';
import { CliError, logger, parseIntFlag } from '../utils/cli';
import { colors, formatId, formatUrl, sectionHeader, symbols } from '../utils/styling';

type UploadListItem = {
  consoleUrl: string;
  created_at: string;
  id: string;
  name: null | string;
};

type ListResponse = {
  limit: number;
  offset: number;
  total: number;
  uploads: UploadListItem[];
};

function detectShellExpansion(name: string): void {
  const indicators = [
    name.includes('/') || name.includes('\\'),
    /\.(yaml|yml|json|txt|md|ts|js|py|sh)$/i.test(name),
    name.includes(' ') && !name.includes('*') && !name.includes('?'),
  ];

  if (indicators.some(Boolean)) {
    logger.warn(
      `\nThe --name parameter appears to have been expanded by your shell: "${name}"\n` +
        'Wildcards like * should be quoted to prevent shell expansion.\n' +
        'Examples:\n' +
        '  ✓ Correct:   dcd list --name "nightly-*"\n' +
        "  ✓ Correct:   dcd list --name 'nightly-*'\n" +
        '  ✗ Incorrect: dcd list --name nightly-*\n',
    );
  }
}

function displayResults(response: ListResponse): void {
  const { uploads, total, limit, offset } = response;

  if (uploads.length === 0) {
    logger.log(`\n${symbols.info} No uploads found matching your criteria.\n`);
    return;
  }

  logger.log(sectionHeader('Recent Uploads'));
  logger.log(
    `   ${colors.dim('Showing')} ${uploads.length} ${colors.dim('of')} ${total} ${colors.dim('uploads')}`,
  );
  if (offset > 0) {
    logger.log(`   ${colors.dim('(offset:')} ${offset}${colors.dim(')')}`);
  }

  logger.log('');

  for (const upload of uploads) {
    const date = new Date(upload.created_at);
    const formattedDate = date.toLocaleDateString('en-US', {
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      year: 'numeric',
    });

    const displayName = upload.name || colors.dim('(unnamed)');
    logger.log(`   ${colors.bold(displayName)}`);
    logger.log(`      ${colors.dim('ID:')} ${formatId(upload.id)}`);
    logger.log(`      ${colors.dim('Created:')} ${formattedDate}`);
    logger.log(`      ${colors.dim('Console:')} ${formatUrl(upload.consoleUrl)}`);
    logger.log('');
  }

  if (total > offset + uploads.length) {
    const remaining = total - (offset + uploads.length);
    logger.log(
      `   ${colors.dim('Use')} --offset ${offset + uploads.length} ${colors.dim('to see the next')} ${Math.min(remaining, limit)} ${colors.dim('uploads')}\n`,
    );
  }

  logger.log(
    `   ${symbols.info} ${colors.dim('Use')} dcd status --upload-id <id> ${colors.dim('for detailed test results')}\n`,
  );
}

export const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List recent flow uploads for your organization',
  },
  args: {
    ...apiFlags,
    from: {
      type: 'string',
      description:
        'Filter uploads created on or after this date (ISO 8601 format, e.g., 2024-01-01)',
    },
    json: {
      type: 'boolean',
      description: 'Output in JSON format',
    },
    limit: {
      type: 'string',
      default: '20',
      description: 'Maximum number of uploads to return',
    },
    name: {
      type: 'string',
      description:
        'Filter by upload name (supports * wildcard, e.g., "nightly-*"). IMPORTANT: Always quote wildcards to prevent shell expansion!',
    },
    offset: {
      type: 'string',
      default: '0',
      description: 'Number of uploads to skip (for pagination)',
    },
    to: {
      type: 'string',
      description:
        'Filter uploads created on or before this date (ISO 8601 format, e.g., 2024-01-31)',
    },
  },
  async run({ args }) {
    const apiKeyFlag = args['api-key'] as string | undefined;
    const apiUrl = args['api-url'] as string;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const name = args.name as string | undefined;
    const json = Boolean(args.json);
    const limit = parseIntFlag(args.limit as string | undefined, 'limit') ?? 20;
    const offset = parseIntFlag(args.offset as string | undefined, 'offset') ?? 0;

    try {
      const auth = await resolveAuth({ apiKeyFlag });

      if (from && Number.isNaN(Date.parse(from))) {
        throw new CliError(
          'Invalid --from date format. Please use ISO 8601 format (e.g., 2024-01-01).',
        );
      }

      if (to && Number.isNaN(Date.parse(to))) {
        throw new CliError(
          'Invalid --to date format. Please use ISO 8601 format (e.g., 2024-01-31).',
        );
      }

      if (name) {
        detectShellExpansion(name);
      }

      try {
        const response = (await ApiGateway.listUploads(apiUrl, auth, {
          from,
          limit,
          name,
          offset,
          to,
        })) as ListResponse;

        if (json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        displayResults(response);
      } catch (error) {
        throw new CliError(
          `Failed to list uploads: ${(error as Error).message}`,
        );
      }
    } catch (error) {
      logger.error(error as Error, { exit: 1, json });
    }
  },
});

export default listCommand;
