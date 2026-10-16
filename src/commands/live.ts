import { type CommandMeta, defineCommand } from 'citty';
import { readFileSync, writeFileSync } from 'node:fs';

import { resolveFrontendUrl } from '../config/environments.js';
import { apiFlags } from '../config/flags/api.flags.js';
import { jsonFlag } from '../config/flags/output.flags.js';
import { ApiGateway } from '../gateways/api-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import type { LiveSession } from '../types/domain/live.types.js';
import { resolveAuth } from '../utils/auth.js';
import { CliError, logger, validateEnum, wantsJson } from '../utils/cli.js';
import { resolveApiUrl } from '../utils/config-store.js';
import { colors, formatUrl } from '../utils/styling.js';
import { type Field, ui } from '../utils/ui.js';

const PLATFORM_OPTIONS = ['android', 'ios'] as const;
type Platform = (typeof PLATFORM_OPTIONS)[number];

const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 2_000;

async function requireAuth(keyFlag: string | undefined): Promise<AuthContext> {
  return resolveAuth({ apiKeyFlag: keyFlag });
}

/** Human output, dropped under --json so stdout carries only the result. */
function humanLog(json: boolean): (m: string) => void {
  return (m) => {
    if (!json) logger.log(m);
  };
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
  log: (m: string) => void = (m) => logger.log(m),
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
      log(`   ${colors.dim(phase)}`);
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

function printExecResult(
  result: { error?: string; output?: string; success: boolean },
  json: boolean,
  extra: Record<string, unknown> = {},
): void {
  if (json) {
    logger.json({
      success: result.success,
      ...(result.output && { output: result.output }),
      ...(result.error && { error: result.error }),
      ...extra,
    });
    return;
  }
  logger.log(
    result.success
      ? ui.success('Command executed successfully')
      : `${ui.statusSymbol('FAILED')} Command failed`,
  );
  if (result.output) {
    logger.log(ui.section('Output'));
    logger.log(result.output);
  }
  if (result.error) {
    logger.log(ui.section('Error'));
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
        '[Android] Device profile to match a cloud run (options: pixel-6, pixel-6-pro, pixel-7, pixel-7-pro, pixel-8, pixel-10, pixel-10-pro, pixel-10-pro-xl, pixel-11)',
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
    json: jsonFlag,
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

    const json = Boolean(args.json);
    const out = humanLog(json);

    out(ui.warn(colors.bold('Live is in beta')));
    out(
      ui.branch([
        'Live device sessions are a beta feature, billed at $0.03/min.',
        `${colors.dim('Not enrolled?')} Contact support to request access.`,
      ]),
    );

    out(ui.running(`Starting ${platform} live session…`));

    const session = await ApiGateway.startLiveSession(apiUrl, auth, {
      binaryUploadId: binaryId,
      deviceLocale,
      platform,
      androidDevice,
      androidApiLevel,
    });

    const frontendUrl = resolveFrontendUrl(apiUrl);
    const consoleUrl = `${frontendUrl}/live?session=${session.session_name}`;

    out(ui.success('Live session started'));
    out(
      ui.branch(
        ui.fields([
          ['session', colors.highlight(session.session_name)],
          ['platform', session.platform],
          ['status', session.status],
          ['console', formatUrl(consoleUrl)],
        ]),
      ),
    );

    let ready: LiveSession | undefined;
    if (args.wait) {
      out(ui.running('Waiting for the device to be ready…'));
      ready = await waitForReady(apiUrl, auth, session.session_name, out);
      out(ui.success(`Device ready${ready.device_model ? ` (${ready.device_model})` : ''}`));
    }

    if (json) {
      logger.json({
        session_name: session.session_name,
        platform: session.platform,
        status: ready?.status ?? session.status,
        ready: Boolean(ready?.ready),
        consoleUrl,
        ...(ready?.device_model && { device_model: ready.device_model }),
      });
      return;
    }

    logger.log(ui.section('Next steps'));
    logger.log(
      ui.branch(
        ui.fields([
          ['install a binary', colors.highlight(`dcd live install --session ${session.session_name} --app-binary-id <id>`)],
          ['run a flow', colors.highlight(`dcd live run --session ${session.session_name} path/to/flow.yaml`)],
          ['inspect screen', colors.highlight(`dcd live hierarchy --session ${session.session_name}`)],
          ['stop session', colors.highlight(`dcd live stop --session ${session.session_name}`)],
        ]),
      ),
    );
  },
});

const installSub = defineCommand({
  meta: { name: 'install', description: 'Install a binary on the device' },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
    json: jsonFlag,
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
    const json = Boolean(args.json);
    const out = humanLog(json);

    out(
      ui.running(
        `Installing binary ${colors.highlight(binaryId)} on session ${colors.highlight(sessionName)}…`,
      ),
    );

    await ApiGateway.installLiveBinary(apiUrl, auth, sessionName, binaryId);

    out(ui.success('Binary installed successfully'));

    if (args.wait) {
      out(ui.running('Waiting for the device to be ready…'));
      await waitForReady(apiUrl, auth, sessionName, out);
      out(ui.success('Device ready'));
    }

    if (json) {
      logger.json({
        status: 'SUCCESS',
        session: sessionName,
        appBinaryId: binaryId,
        ready: Boolean(args.wait),
      });
    }
  },
});

const execSub = defineCommand({
  meta: { name: 'exec', description: 'Execute Maestro YAML commands' },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
    json: jsonFlag,
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

    const json = Boolean(args.json);
    const out = humanLog(json);

    if (args.wait) {
      await waitForReady(apiUrl, auth, sessionName, out);
    }

    out(ui.running(`Executing commands on session ${colors.highlight(sessionName)}…`));

    const result = await ApiGateway.execLiveYaml(apiUrl, auth, sessionName, yaml);
    printExecResult(result, json);
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
    json: jsonFlag,
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

    const json = Boolean(args.json);
    const out = humanLog(json);

    // Print the result, then fail with exit 2 if the flow failed. Under --json
    // the result object is the output, so exit without printing a second one.
    const finish = (
      result: { error?: string; output?: string; success: boolean },
      extra: Record<string, unknown> = {},
    ): void => {
      printExecResult(result, json, extra);
      if (result.success) return;
      if (json) logger.fail(result.error || 'Flow failed.', 2);
      throw new CliError(result.error || 'Flow failed.', 2);
    };

    if (args.wait) {
      await waitForReady(apiUrl, auth, sessionName, out);
    }

    out(
      ui.running(
        `Running ${colors.highlight(flowFile)} on session ${colors.highlight(sessionName)}…`,
      ),
    );

    // Submit asynchronously and poll, so a long flow isn't capped by the
    // server's 120s synchronous exec limit. Older servers ignore `async` and
    // return the full result inline — handle that by falling through.
    const submitted = await ApiGateway.execLiveYaml(apiUrl, auth, sessionName, commands, {
      async: true,
    });

    if (!submitted.commandId) {
      finish(submitted);
      return;
    }

    const commandId = submitted.commandId;
    const deadline = Date.now() + timeoutMs;
    let lastKeepalive = Date.now();
    for (;;) {
      const status = await ApiGateway.getLiveCommand(apiUrl, auth, sessionName, commandId);
      if (status.done) {
        finish(status, { commandId });
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
    json: jsonFlag,
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

    if (args.json) {
      logger.json({
        status: 'SUCCESS',
        path: output,
        format: ext,
        ...(session.hierarchy && {
          width: session.hierarchy.width,
          height: session.hierarchy.height,
        }),
      });
      return;
    }

    logger.log(ui.success(`Screenshot saved to ${colors.highlight(output)}`));
    if (session.hierarchy) {
      logger.log(
        ui.branch(
          ui.fields([
            ['resolution', `${session.hierarchy.width}x${session.hierarchy.height}`],
          ]),
        ),
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
    json: {
      type: 'boolean',
      description:
        'Output the raw hierarchy as JSON (with --output, the file gets the hierarchy and stdout gets { status, path })',
    },
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
      if (output) {
        writeFileSync(output, JSON.stringify(hierarchy, null, 2));
        logger.json({ status: 'SUCCESS', path: output });
      } else {
        logger.json(hierarchy);
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
      logger.log(ui.success(`Hierarchy written to ${colors.highlight(output)}`));
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
    json: jsonFlag,
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const sessionName = args.session as string;

    const json = Boolean(args.json);

    humanLog(json)(ui.running(`Stopping session ${colors.highlight(sessionName)}…`));

    await ApiGateway.stopLiveSession(apiUrl, auth, sessionName);

    if (json) {
      logger.json({ status: 'SUCCESS', session: sessionName });
      return;
    }
    logger.log(ui.success('Session stopped'));
  },
});

const statusSub = defineCommand({
  meta: { name: 'status', description: 'Get session status' },
  args: {
    ...apiFlags,
    session: { type: 'string', required: true, description: 'Live session name' },
    json: jsonFlag,
  },
  async run({ args }) {
    const auth = await requireAuth(args['api-key'] as string | undefined);
    const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
    const sessionName = args.session as string;

    const session = await ApiGateway.getLiveSession(apiUrl, auth, sessionName);

    if (args.json) {
      // The screenshot and hierarchy are large; `screenshot` / `hierarchy`
      // are the commands for those.
      const { hierarchy: _hierarchy, screenshot_data_url: _screenshot, ...rest } = session;
      logger.json(rest);
      return;
    }

    const fields: Field[] = [
      ['session', colors.highlight(session.session_name)],
      ['platform', session.platform],
      ['status', session.status],
      ['ready', session.ready ? colors.success('yes') : colors.warning('no')],
    ];
    const phase = session.device_state?.phase_label ?? session.device_state?.phase;
    if (phase) {
      fields.push(['phase', phase]);
    }
    if (session.device_model) {
      fields.push(['device', session.device_model]);
    }
    if (session.device_locale) {
      fields.push(['locale', session.device_locale]);
    }
    if (session.binary_upload_id) {
      fields.push(['binary', session.binary_upload_id]);
    }
    if (typeof session.seconds_until_auto_cancel === 'number') {
      fields.push(['auto-cancel in', `${session.seconds_until_auto_cancel}s`]);
    }
    fields.push(['created', new Date(session.created_at).toLocaleString()]);

    logger.log(ui.section('Live Session'));
    logger.log(ui.branch(ui.fields(fields)));
  },
});

const subCommands = {
  start: startSub,
  install: installSub,
  exec: execSub,
  run: runSub,
  screenshot: screenshotSub,
  hierarchy: hierarchySub,
  stop: stopSub,
  status: statusSub,
};

export const liveCommand = defineCommand({
  meta: {
    name: 'live',
    description: 'Start and interact with a live device session',
  },
  subCommands,
  // citty's runCommand does not early-return after dispatching to a
  // subcommand — it still invokes the parent `run` afterwards. So when a
  // subcommand was matched, bail out here; otherwise the menu would print
  // after every successful subcommand.
  run({ rawArgs }) {
    const subNames = new Set(Object.keys(subCommands));
    const firstPositional = rawArgs.find((arg) => !arg.startsWith('-'));
    if (firstPositional && subNames.has(firstPositional)) return;

    if (wantsJson(rawArgs)) {
      logger.json({
        commands: Object.entries(subCommands).map(([name, sub]) => ({
          name,
          description: (sub.meta as CommandMeta).description,
        })),
      });
      return;
    }

    logger.log(ui.section('Live Session Commands'));
    logger.log(
      ui.branch(
        ui.fields([
          [colors.bold('start'), 'Start a new live device session'],
          [colors.bold('install'), 'Install a binary on the device'],
          [colors.bold('exec'), 'Execute Maestro YAML commands'],
          [colors.bold('run'), 'Run a whole Maestro flow file'],
          [colors.bold('screenshot'), 'Save the current device screen to an image file'],
          [colors.bold('hierarchy'), 'Dump the current view hierarchy (selectors)'],
          [colors.bold('stop'), 'Stop a live session'],
          [colors.bold('status'), 'Get session status'],
        ]),
      ),
    );
    logger.log(ui.note(`\nRun ${colors.highlight('dcd live <command> --help')} for details`));
  },
});

export default liveCommand;
