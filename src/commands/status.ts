import { defineCommand } from 'citty';

import { apiFlags } from '../config/flags/api.flags.js';
import { resolveFrontendUrl } from '../config/environments.js';
import { ApiGateway } from '../gateways/api-gateway.js';
import { formatDurationSeconds } from '../methods.js';
import { resolveAuth } from '../utils/auth.js';
import { CliError, logger } from '../utils/cli.js';
import { resolveApiUrl } from '../utils/config-store.js';
import {
  ConnectivityCheckResult,
  checkInternetConnectivity,
} from '../utils/connectivity.js';
import { colors, formatId, formatUrl } from '../utils/styling.js';
import { type Field, ui } from '../utils/ui.js';

type StatusKind = 'CANCELLED' | 'FAILED' | 'PASSED' | 'PENDING' | 'QUEUED' | 'RUNNING';

type StatusResponse = {
  appBinaryId?: string;
  attempts?: number;
  connectivityCheck?: {
    connected: boolean;
    endpointResults: ConnectivityCheckResult['endpointResults'];
    message: string;
  };
  consoleUrl?: string;
  createdAt?: string;
  error?: string;
  name?: string;
  status: StatusKind;
  tests: {
    createdAt?: string;
    durationSeconds?: number;
    failReason?: string;
    name: string;
    status: StatusKind;
  }[];
  uploadId?: string;
};

/** Errors the API gateway surfaces for 4xx-class failures — retrying is pointless. */
function isClientApiError(error: Error | null): boolean {
  if (!error) return false;
  return (
    error.message.includes('Invalid request:') ||
    error.message.includes('Resource not found') ||
    error.message.includes('Authentication failed') ||
    error.message.includes('Access denied') ||
    error.message.includes('Invalid API key') ||
    error.message.includes('Rate limit exceeded')
  );
}

function formatDateTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString();
  } catch {
    return isoString;
  }
}

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Get the status of an upload by name or upload ID',
  },
  args: {
    ...apiFlags,
    json: {
      type: 'boolean',
      description: 'output in json format',
    },
    name: {
      type: 'string',
      description: 'Name of the upload to check status for',
    },
    'upload-id': {
      type: 'string',
      description: 'UUID of the upload to check status for',
    },
  },
  // eslint-disable-next-line complexity
  async run({ args }) {
    const apiKeyFlag = args['api-key'] as string | undefined;
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const json = Boolean(args.json);
    const name = args.name as string | undefined;
    const uploadId = args['upload-id'] as string | undefined;

    try {
      await statusMain({ apiKeyFlag, apiUrl, json, name, uploadId });
    } catch (error) {
      logger.error(error as Error, { exit: 1, json });
    }
  },
});

async function statusMain({
  apiKeyFlag,
  apiUrl,
  json,
  name,
  uploadId,
}: {
  apiKeyFlag: string | undefined;
  apiUrl: string;
  json: boolean;
  name: string | undefined;
  uploadId: string | undefined;
}): Promise<void> {

    const auth = await resolveAuth({ apiKeyFlag });

    if (name && uploadId) {
      throw new CliError(
        'Cannot provide both --name and --upload-id. These options are mutually exclusive.',
      );
    }

    if (!name && !uploadId) {
      throw new CliError('Either --name or --upload-id must be provided');
    }

    let lastError: Error | null = null;
    let status: StatusResponse | null = null;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        attemptsMade = attempt;
        status = (await ApiGateway.getUploadStatus(apiUrl, auth, {
          name,
          uploadId,
        })) as StatusResponse;
        break;
      } catch (error) {
        lastError = error as Error;

        const isNetworkError =
          lastError.name === 'NetworkError' ||
          (error instanceof TypeError && lastError.message === 'fetch failed');

        if (isClientApiError(lastError)) {
          break;
        }

        if (attempt < 5) {
          logger.log(
            isNetworkError
              ? `Network error on attempt ${attempt}/5. Retrying...`
              : `Request failed on attempt ${attempt}/5. Retrying...`,
          );
          await new Promise((resolve) => {
            setTimeout(resolve, 1000 * attempt);
          });
        }
      }
    }

    if (!status) {
      if (isClientApiError(lastError)) {
        const errorMessage = lastError?.message || 'Unknown error';
        if (json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                status: 'FAILED' as const,
                error: errorMessage,
                attempts: attemptsMade,
                tests: [],
              },
              null,
              2,
            ),
          );
          return;
        }

        throw new CliError(errorMessage);
      }

      const connectivityCheck = await checkInternetConnectivity();

      let errorMessage: string;
      if (connectivityCheck.connected) {
        errorMessage = `Failed to get status after ${attemptsMade} attempt${
          attemptsMade > 1 ? 's' : ''
        }. Internet appears functional but unable to reach API. Last error: ${
          lastError?.message || 'Unknown error'
        }`;
      } else {
        const endpointDetails = connectivityCheck.endpointResults
          .map((r) => `  - ${r.endpoint}: ${r.error} (${r.latencyMs}ms)`)
          .join('\n');

        errorMessage = `Failed to get status after ${attemptsMade} attempt${
          attemptsMade > 1 ? 's' : ''
        }.\n\nInternet connectivity check failed - all test endpoints unreachable:\n${endpointDetails}\n\nPlease verify your network connection and DNS resolution.\nLast API error: ${
          lastError?.message || 'Unknown error'
        }`;
      }

      if (json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              status: 'FAILED' as const,
              error: errorMessage,
              attempts: attemptsMade,
              connectivityCheck: {
                connected: connectivityCheck.connected,
                endpointResults: connectivityCheck.endpointResults,
                message: connectivityCheck.message,
              },
              tests: [],
            },
            null,
            2,
          ),
        );
        return;
      }

      throw new CliError(errorMessage);
    }

    try {
      if (json) {
        const { tests, ...rest } = status;
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ ...rest, tests }, null, 2));
        return;
      }

      const fields: Field[] = [];
      if (status.name) {
        fields.push(['name', colors.bold(status.name)]);
      }
      if (status.uploadId) {
        fields.push(['upload id', formatId(status.uploadId)]);
      }
      if (status.appBinaryId) {
        fields.push(['binary id', formatId(status.appBinaryId)]);
      }
      if (status.createdAt) {
        fields.push(['created', formatDateTime(status.createdAt)]);
      }
      // Prefer a console link built from the env the CLI is pointed at (the
      // API-supplied consoleUrl is hardcoded to prod, so it misdirects
      // dev/staging users); fall back to the API value if we have no uploadId.
      const consoleUrl = status.uploadId
        ? `${resolveFrontendUrl(apiUrl)}/results?upload=${status.uploadId}`
        : status.consoleUrl;
      if (consoleUrl) {
        fields.push(['console', formatUrl(consoleUrl)]);
      }

      logger.log(ui.section('Upload Status'));
      logger.log(ui.branch([ui.status(status.status), ...ui.fields(fields)]));

      if (status.tests.length > 0) {
        logger.log(ui.section('Test Results'));
        logger.log(
          ui.branch(
            status.tests.map((item) => {
              const head = `${ui.statusSymbol(item.status)} ${item.name}`;
              const meta: string[] = [];
              if (item.durationSeconds) {
                meta.push(formatDurationSeconds(item.durationSeconds));
              }
              if (item.createdAt) {
                meta.push(colors.dim(formatDateTime(item.createdAt)));
              }
              if (item.status === 'FAILED' && item.failReason) {
                meta.push(colors.error(item.failReason));
              }
              return meta.length > 0
                ? `${head}   ${colors.dim('·')} ${meta.join(colors.dim(' · '))}`
                : head;
            }),
          ),
        );
      }
    } catch (error) {
      throw new CliError(`Failed to get status: ${(error as Error).message}`);
    }
}

export default statusCommand;
