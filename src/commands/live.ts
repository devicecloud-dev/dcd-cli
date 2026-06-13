import { defineCommand } from 'citty';

import { resolveFrontendUrl } from '../config/environments';
import { apiFlags } from '../config/flags/api.flags';
import { ApiGateway } from '../gateways/api-gateway';
import type { AuthContext } from '../types/domain/auth.types';
import { resolveAuth } from '../utils/auth';
import { logger, validateEnum } from '../utils/cli';
import { colors, sectionHeader, symbols } from '../utils/styling';

const PLATFORM_OPTIONS = ['android', 'ios'] as const;
type Platform = (typeof PLATFORM_OPTIONS)[number];

async function requireAuth(keyFlag: string | undefined): Promise<AuthContext> {
  return resolveAuth({ apiKeyFlag: keyFlag });
}

const startSub = defineCommand({
  meta: { name: 'start', description: 'Start a new live device session' },
  args: {
    ...apiFlags,
    platform: {
      type: 'string',
      default: 'android',
      description: 'Device platform (options: android, ios)',
    },
    'app-binary-id': {
      type: 'string',
      description: 'Binary upload ID to install on the device',
    },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = args['api-url'] as string;
    const platform = validateEnum(
      args.platform as string | undefined,
      PLATFORM_OPTIONS,
      'platform',
    ) as Platform;
    const binaryId = args['app-binary-id'] as string | undefined;

    logger.log(`${symbols.running} Starting ${platform} live session...`);

    const session = await ApiGateway.startLiveSession(apiUrl, auth, {
      binaryUploadId: binaryId,
      platform,
    });

    const frontendUrl = resolveFrontendUrl(apiUrl);

    logger.log(`${symbols.success} Live session started`);
    logger.log(`   ${colors.dim('Session:')}    ${colors.highlight(session.session_name)}`);
    logger.log(`   ${colors.dim('Platform:')}   ${session.platform}`);
    logger.log(`   ${colors.dim('Status:')}     ${session.status}`);
    logger.log(
      `   ${colors.dim('Console:')}    ${colors.highlight(`${frontendUrl}/live?session=${session.session_name}`)}`,
    );
    logger.log('');
    logger.log(
      `   ${colors.dim('Install a binary:')}  ${colors.highlight(`dcd live install --session ${session.session_name} --app-binary-id <id>`)}`,
    );
    logger.log(
      `   ${colors.dim('Run a command:')}     ${colors.highlight(`dcd live exec --session ${session.session_name} --yaml "- launchApp"`)}`,
    );
    logger.log(
      `   ${colors.dim('Stop session:')}      ${colors.highlight(`dcd live stop --session ${session.session_name}`)}`,
    );
  },
});

const installSub = defineCommand({
  meta: { name: 'install', description: 'Install a binary on the device' },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
    'app-binary-id': {
      type: 'string',
      required: true,
      description: 'Binary upload ID to install on the device',
    },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = args['api-url'] as string;
    const sessionName = args.session as string;
    const binaryId = args['app-binary-id'] as string;

    logger.log(
      `${symbols.running} Installing binary ${colors.highlight(binaryId)} on session ${colors.highlight(sessionName)}...`,
    );

    await ApiGateway.installLiveBinary(apiUrl, auth, sessionName, binaryId);

    logger.log(`${symbols.success} Binary installed successfully`);
  },
});

const execSub = defineCommand({
  meta: { name: 'exec', description: 'Execute Maestro YAML commands' },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
    yaml: { type: 'string', required: true, description: 'Maestro YAML commands to execute' },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = args['api-url'] as string;
    const sessionName = args.session as string;
    const yaml = args.yaml as string;

    logger.log(
      `${symbols.running} Executing commands on session ${colors.highlight(sessionName)}...`,
    );

    const result = await ApiGateway.execLiveYaml(apiUrl, auth, sessionName, yaml);

    logger.log(
      result.success
        ? `${symbols.success} Command executed successfully`
        : `${symbols.error} Command failed`,
    );

    if (result.output) {
      logger.log(sectionHeader('Output'));
      logger.log(result.output);
    }

    if (result.error) {
      logger.log(sectionHeader('Error'));
      logger.log(colors.error(result.error));
    }
  },
});

const stopSub = defineCommand({
  meta: { name: 'stop', description: 'Stop a live session' },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = args['api-url'] as string;
    const sessionName = args.session as string;

    logger.log(`${symbols.running} Stopping session ${colors.highlight(sessionName)}...`);

    await ApiGateway.stopLiveSession(apiUrl, auth, sessionName);

    logger.log(`${symbols.success} Session stopped`);
  },
});

const statusSub = defineCommand({
  meta: { name: 'status', description: 'Get session status' },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = args['api-url'] as string;
    const sessionName = args.session as string;

    const session = await ApiGateway.getLiveSession(apiUrl, auth, sessionName);

    logger.log(sectionHeader('Live Session'));
    logger.log(`   ${colors.dim('Session:')}    ${colors.highlight(session.session_name)}`);
    logger.log(`   ${colors.dim('Platform:')}   ${session.platform}`);
    logger.log(`   ${colors.dim('Status:')}     ${session.status}`);
    if (session.binary_upload_id) {
      logger.log(`   ${colors.dim('Binary:')}     ${session.binary_upload_id}`);
    }
    logger.log(
      `   ${colors.dim('Created:')}    ${new Date(session.created_at).toLocaleString()}`,
    );
  },
});

export const liveCommand = defineCommand({
  meta: {
    name: 'live',
    description: 'Start and interact with a live device session',
  },
  subCommands: {
    start: startSub,
    install: installSub,
    exec: execSub,
    stop: stopSub,
    status: statusSub,
  },
  run() {
    logger.log(sectionHeader('Live Session Commands'));
    logger.log(`   ${colors.bold('start')}    Start a new live device session`);
    logger.log(`   ${colors.bold('install')}  Install a binary on the device`);
    logger.log(`   ${colors.bold('exec')}     Execute Maestro YAML commands`);
    logger.log(`   ${colors.bold('stop')}     Stop a live session`);
    logger.log(`   ${colors.bold('status')}   Get session status`);
    logger.log('');
    logger.log(`   Run ${colors.highlight('dcd live <command> --help')} for details`);
  },
});

export default liveCommand;
