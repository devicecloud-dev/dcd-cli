import { defineCommand } from 'citty';
import { readFileSync, writeFileSync } from 'node:fs';

import { resolveFrontendUrl } from '../config/environments';
import { apiFlags } from '../config/flags/api.flags';
import { ApiGateway } from '../gateways/api-gateway';
import type { AuthContext } from '../types/domain/auth.types';
import type { LiveSession } from '../types/domain/live.types';
import { resolveAuth } from '../utils/auth';
import { CliError, logger, validateEnum } from '../utils/cli';
import { resolveApiUrl } from '../utils/config-store';
import { colors, sectionHeader, symbols } from '../utils/styling';

const PLATFORM_OPTIONS = ['android', 'ios'] as const;
type Platform = (typeof PLATFORM_OPTIONS)[number];

const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 2_000;

async function requireAuth(keyFlag: string | undefined): Promise<AuthContext> {
  return resolveAuth({ apiKeyFlag: keyFlag });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the session until it reports `ready` (RUNNING + device streaming),
 * surfacing each new device phase so the user sees "Cloning device…",
 * "Installing app…", etc. Removes the need to hand-roll retry loops around the
 * 425/409 "not ready" window that `exec` returns right after start/install.
 */
async function waitForReady(
  apiUrl: string,
  auth: AuthContext,
  sessionName: string,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<LiveSession> {
  const deadline = Date.now() + timeoutMs;
  let lastPhase = '';
  for (;;) {
    const session = await ApiGateway.getLiveSession(apiUrl, auth, sessionName);
    if (session.ready) return session;
    if (['CANCELLED', 'FAILED', 'STOPPED'].includes(session.status?.toUpperCase?.() ?? '')) {
      throw new CliError(`Session ${sessionName} is ${session.status}; cannot become ready.`);
    }

    const phase =
      session.device_state?.phase_label ?? session.device_state?.phase ?? session.status;
    if (phase && phase !== lastPhase) {
      lastPhase = phase;
      logger.log(`   ${colors.dim(phase)}`);
    }

    if (Date.now() >= deadline) {
      throw new CliError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the device to be ready` +
          (phase ? ` (last phase: ${phase})` : '') +
          '.',
      );
    }
    await sleep(READY_POLL_MS);
  }
}

/**
 * Strip a Maestro flow header (`appId: ...` config block up to and including the
 * first `---`) so a whole flow file can be fed to the exec endpoint, which wants
 * just the command list. Returns the input unchanged if there's no `---`.
 */
function extractFlowCommands(text: string): string {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === '---');
  if (idx === -1) return text.trim();
  return lines.slice(idx + 1).join('\n').trim();
}

/**
 * citty/mri silently drops the value after `--flag` when that value starts with
 * `-` (e.g. `--yaml "- launchApp"`) for non-required string args. Recover it
 * from the raw argv so the ergonomic inline form keeps working.
 */
function recoverFlagValue(
  flag: string,
  parsed: string | undefined,
  rawArgs: string[],
): string | undefined {
  if (parsed && parsed.trim()) return parsed;
  const eq = rawArgs.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = rawArgs.indexOf(flag);
  if (idx !== -1 && idx + 1 < rawArgs.length) return rawArgs[idx + 1];
  return parsed;
}

function readFlowFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new CliError(`Could not read flow file '${filePath}': ${(err as Error).message}`);
  }
}

function printExecResult(result: { error?: string; output?: string; success: boolean }): void {
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
    'device-locale': {
      type: 'string',
      description: 'Device locale, ISO-639-1 + ISO-3166-1, e.g. "de_DE"',
    },
    'android-device': {
      type: 'string',
      description:
        '[Android] Device profile to match a cloud run (options: pixel-6, pixel-6-pro, pixel-7, pixel-7-pro, generic-tablet)',
    },
    'android-api-level': {
      type: 'string',
      description: '[Android] API level for the device, e.g. 34 (requires --android-device)',
    },
    wait: {
      type: 'boolean',
      default: false,
      description: 'Block until the device is ready to accept commands',
    },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const platform = validateEnum(
      args.platform as string | undefined,
      PLATFORM_OPTIONS,
      'platform',
    ) as Platform;
    const binaryId = args['app-binary-id'] as string | undefined;
    const deviceLocale = args['device-locale'] as string | undefined;
    const androidDevice = args['android-device'] as string | undefined;
    const androidApiLevel = args['android-api-level'] as string | undefined;

    if ((androidDevice || androidApiLevel) && platform !== 'android') {
      throw new CliError('--android-device/--android-api-level are only valid with --platform android.');
    }
    if (Boolean(androidDevice) !== Boolean(androidApiLevel)) {
      throw new CliError('--android-device and --android-api-level must be provided together.');
    }

    logger.log(`${symbols.running} Starting ${platform} live session...`);

    const session = await ApiGateway.startLiveSession(apiUrl, auth, {
      binaryUploadId: binaryId,
      deviceLocale,
      platform,
      androidDevice,
      androidApiLevel,
    });

    const frontendUrl = resolveFrontendUrl(apiUrl);

    logger.log(`${symbols.success} Live session started`);
    logger.log(`   ${colors.dim('Session:')}    ${colors.highlight(session.session_name)}`);
    logger.log(`   ${colors.dim('Platform:')}   ${session.platform}`);
    logger.log(`   ${colors.dim('Status:')}     ${session.status}`);
    logger.log(
      `   ${colors.dim('Console:')}    ${colors.highlight(`${frontendUrl}/live?session=${session.session_name}`)}`,
    );

    if (args.wait) {
      logger.log('');
      logger.log(`${symbols.running} Waiting for the device to be ready...`);
      const ready = await waitForReady(apiUrl, auth, session.session_name);
      logger.log(`${symbols.success} Device ready${ready.device_model ? ` (${ready.device_model})` : ''}`);
    }

    logger.log('');
    logger.log(
      `   ${colors.dim('Install a binary:')}  ${colors.highlight(`dcd live install --session ${session.session_name} --app-binary-id <id>`)}`,
    );
    logger.log(
      `   ${colors.dim('Run a flow:')}        ${colors.highlight(`dcd live run --session ${session.session_name} path/to/flow.yaml`)}`,
    );
    logger.log(
      `   ${colors.dim('Inspect screen:')}    ${colors.highlight(`dcd live hierarchy --session ${session.session_name}`)}`,
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
    wait: {
      type: 'boolean',
      default: false,
      description: 'Block until the device is ready again after installing',
    },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const sessionName = args.session as string;
    const binaryId = args['app-binary-id'] as string;

    logger.log(
      `${symbols.running} Installing binary ${colors.highlight(binaryId)} on session ${colors.highlight(sessionName)}...`,
    );

    await ApiGateway.installLiveBinary(apiUrl, auth, sessionName, binaryId);

    logger.log(`${symbols.success} Binary installed successfully`);

    if (args.wait) {
      logger.log(`${symbols.running} Waiting for the device to be ready...`);
      await waitForReady(apiUrl, auth, sessionName);
      logger.log(`${symbols.success} Device ready`);
    }
  },
});

const execSub = defineCommand({
  meta: { name: 'exec', description: 'Execute Maestro YAML commands' },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
    yaml: { type: 'string', description: 'Maestro YAML commands to execute' },
    file: {
      type: 'string',
      description: 'Path to a file containing the Maestro YAML to execute',
    },
    wait: {
      type: 'boolean',
      default: false,
      description: 'Wait for the device to be ready before executing',
    },
  },
  async run({ args, rawArgs }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const sessionName = args.session as string;
    const inlineYaml = recoverFlagValue('--yaml', args.yaml as string | undefined, rawArgs);
    const file = args.file as string | undefined;

    if (inlineYaml && file) {
      throw new CliError('Pass either --yaml or --file, not both.');
    }
    const yaml = file ? readFlowFile(file) : inlineYaml;
    if (!yaml || !yaml.trim()) {
      throw new CliError('Provide commands to execute via --yaml or --file.');
    }

    if (args.wait) {
      await waitForReady(apiUrl, auth, sessionName);
    }

    logger.log(
      `${symbols.running} Executing commands on session ${colors.highlight(sessionName)}...`,
    );

    const result = await ApiGateway.execLiveYaml(apiUrl, auth, sessionName, yaml);
    printExecResult(result);
  },
});

const runSub = defineCommand({
  meta: {
    name: 'run',
    description: 'Run a whole Maestro flow file against the live session',
  },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
    wait: {
      type: 'boolean',
      default: false,
      description: 'Wait for the device to be ready before running',
    },
    timeout: {
      type: 'string',
      default: '600',
      description: 'Max seconds to wait for the flow to finish (default 600)',
    },
    flowFile: {
      type: 'positional',
      required: true,
      description: 'Path to the Maestro flow file to run (e.g. flow.yaml)',
    },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const sessionName = args.session as string;
    const flowFile = args.flowFile as string;
    const timeoutMs = Math.max(1, Number(args.timeout) || 600) * 1000;

    const commands = extractFlowCommands(readFlowFile(flowFile));
    if (!commands) {
      throw new CliError(`Flow file '${flowFile}' has no commands to run.`);
    }

    if (args.wait) {
      await waitForReady(apiUrl, auth, sessionName);
    }

    logger.log(
      `${symbols.running} Running ${colors.highlight(flowFile)} on session ${colors.highlight(sessionName)}...`,
    );

    // Submit asynchronously and poll, so a long flow isn't capped by the
    // server's 120s synchronous exec limit. Older servers ignore `async` and
    // return the full result inline — handle that by falling through.
    const submitted = await ApiGateway.execLiveYaml(apiUrl, auth, sessionName, commands, {
      async: true,
    });

    if (!submitted.commandId) {
      printExecResult(submitted);
      if (!submitted.success) throw new CliError(submitted.error || 'Flow failed.', 2);
      return;
    }

    const commandId = submitted.commandId;
    const deadline = Date.now() + timeoutMs;
    let lastKeepalive = Date.now();
    for (;;) {
      const status = await ApiGateway.getLiveCommand(apiUrl, auth, sessionName, commandId);
      if (status.done) {
        printExecResult(status);
        if (!status.success) throw new CliError(status.error || 'Flow failed.', 2);
        return;
      }
      if (Date.now() >= deadline) {
        throw new CliError(
          `Flow still running after ${Math.round(timeoutMs / 1000)}s (command ${commandId}). ` +
            'Raise --timeout if the flow legitimately runs longer.',
          2,
        );
      }
      // Keep the session alive during long polls so the inactivity sweep
      // doesn't cancel it mid-flow.
      if (Date.now() - lastKeepalive > 60_000) {
        await ApiGateway.keepaliveLiveSession(apiUrl, auth, sessionName);
        lastKeepalive = Date.now();
      }
      await sleep(2_000);
    }
  },
});

const screenshotSub = defineCommand({
  meta: {
    name: 'screenshot',
    description: 'Save the current device screen to an image file (PNG/JPEG)',
  },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
    output: {
      type: 'string',
      alias: ['o'],
      description:
        'File path to write the screenshot to (default: live-screenshot.<ext> matching the device format)',
    },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const sessionName = args.session as string;

    const session = await ApiGateway.getLiveSession(apiUrl, auth, sessionName);
    const dataUrl = session.screenshot_data_url ?? session.hierarchy?.screenshot;
    if (!dataUrl) {
      throw new CliError(
        `No screenshot available yet for ${sessionName}. The device may not be streaming — ` +
          'try again, or start/install with --wait.',
      );
    }

    const match = /^data:image\/(\w+);base64,(.+)$/s.exec(dataUrl);
    const ext = match ? match[1].replace('jpeg', 'jpg') : 'png';
    const base64 = match ? match[2] : dataUrl;
    const output = (args.output as string | undefined) ?? `live-screenshot.${ext}`;

    writeFileSync(output, Buffer.from(base64, 'base64'));

    logger.log(`${symbols.success} Screenshot saved to ${colors.highlight(output)}`);
    if (session.hierarchy) {
      logger.log(
        `   ${colors.dim('Resolution:')} ${session.hierarchy.width}x${session.hierarchy.height}`,
      );
    }
  },
});

const hierarchySub = defineCommand({
  meta: {
    name: 'hierarchy',
    description: 'Dump the current view hierarchy (the selectors you can tap/assert on)',
  },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
    json: { type: 'boolean', description: 'Output the raw hierarchy as JSON' },
    output: {
      type: 'string',
      alias: ['o'],
      description: 'Write the output to a file instead of stdout',
    },
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const sessionName = args.session as string;
    const json = Boolean(args.json);
    const output = args.output as string | undefined;

    const session = await ApiGateway.getLiveSession(apiUrl, auth, sessionName);
    const hierarchy = session.hierarchy;
    if (!hierarchy) {
      throw new CliError(
        `No hierarchy available yet for ${sessionName}. The device may not be streaming — ` +
          'try again, or start/install with --wait.',
      );
    }

    if (json) {
      const out = JSON.stringify(hierarchy, null, 2);
      if (output) {
        writeFileSync(output, out);
        logger.log(`${symbols.success} Hierarchy written to ${colors.highlight(output)}`);
      } else {
        // eslint-disable-next-line no-console
        console.log(out);
      }
      return;
    }

    // Human-readable: only the nodes worth selecting on (have text / a11y / id).
    const lines: string[] = [];
    lines.push(
      `Hierarchy — ${hierarchy.width}x${hierarchy.height}, ${hierarchy.elements.length} elements`,
    );
    for (const el of hierarchy.elements) {
      const parts: string[] = [];
      if (el.text) parts.push(`"${el.text}"`);
      if (el.accessibilityText) parts.push(`a11y:"${el.accessibilityText}"`);
      if (el.resourceId) parts.push(`id:${el.resourceId}`);
      if (parts.length === 0) continue;
      const bounds = el.bounds
        ? `  ${colors.dim(`(${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height})`)}`
        : '';
      lines.push(`  ${parts.join('  ')}${bounds}`);
    }
    const out = lines.join('\n');

    if (output) {
      writeFileSync(output, `${out}\n`);
      logger.log(`${symbols.success} Hierarchy written to ${colors.highlight(output)}`);
    } else {
      logger.log(out);
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
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
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
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const sessionName = args.session as string;

    const session = await ApiGateway.getLiveSession(apiUrl, auth, sessionName);

    logger.log(sectionHeader('Live Session'));
    logger.log(`   ${colors.dim('Session:')}    ${colors.highlight(session.session_name)}`);
    logger.log(`   ${colors.dim('Platform:')}   ${session.platform}`);
    logger.log(`   ${colors.dim('Status:')}     ${session.status}`);
    logger.log(
      `   ${colors.dim('Ready:')}      ${session.ready ? colors.success('yes') : colors.warning('no')}`,
    );
    const phase = session.device_state?.phase_label ?? session.device_state?.phase;
    if (phase) {
      logger.log(`   ${colors.dim('Phase:')}      ${phase}`);
    }
    if (session.device_model) {
      logger.log(`   ${colors.dim('Device:')}     ${session.device_model}`);
    }
    if (session.device_locale) {
      logger.log(`   ${colors.dim('Locale:')}     ${session.device_locale}`);
    }
    if (session.binary_upload_id) {
      logger.log(`   ${colors.dim('Binary:')}     ${session.binary_upload_id}`);
    }
    if (typeof session.seconds_until_auto_cancel === 'number') {
      logger.log(
        `   ${colors.dim('Auto-cancel in:')} ${session.seconds_until_auto_cancel}s`,
      );
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
    run: runSub,
    screenshot: screenshotSub,
    hierarchy: hierarchySub,
    stop: stopSub,
    status: statusSub,
  },
  // citty's runCommand does not early-return after dispatching to a
  // subcommand — it still invokes the parent `run` afterwards. So when a
  // subcommand was matched, bail out here; otherwise the menu would print
  // after every successful subcommand.
  run({ rawArgs }) {
    const subNames = new Set([
      'start',
      'install',
      'exec',
      'run',
      'screenshot',
      'hierarchy',
      'stop',
      'status',
    ]);
    const firstPositional = rawArgs.find((arg) => !arg.startsWith('-'));
    if (firstPositional && subNames.has(firstPositional)) return;

    logger.log(sectionHeader('Live Session Commands'));
    logger.log(`   ${colors.bold('start')}       Start a new live device session`);
    logger.log(`   ${colors.bold('install')}     Install a binary on the device`);
    logger.log(`   ${colors.bold('exec')}        Execute Maestro YAML commands`);
    logger.log(`   ${colors.bold('run')}         Run a whole Maestro flow file`);
    logger.log(`   ${colors.bold('screenshot')}  Save the current device screen to an image file`);
    logger.log(`   ${colors.bold('hierarchy')}   Dump the current view hierarchy (selectors)`);
    logger.log(`   ${colors.bold('stop')}        Stop a live session`);
    logger.log(`   ${colors.bold('status')}      Get session status`);
    logger.log('');
    logger.log(`   Run ${colors.highlight('dcd live <command> --help')} for details`);
  },
});

export default liveCommand;
