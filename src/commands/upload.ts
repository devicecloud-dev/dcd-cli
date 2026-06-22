import { defineCommand } from 'citty';
import { rm } from 'node:fs/promises';

import { apiFlags } from '../config/flags/api.flags.js';
import { binaryFlags } from '../config/flags/binary.flags.js';
import { outputFlags } from '../config/flags/output.flags.js';
import { uploadBinary, verifyAppZip } from '../methods.js';
import { resolveAuth } from '../utils/auth.js';
import { CliError, logger } from '../utils/cli.js';
import { resolveApiUrl } from '../utils/config-store.js';
import { downloadExpoUrl, extractTarGz, findAppBundle, isUrl } from '../utils/expo.js';
import { colors, formatId, sectionHeader, symbols } from '../utils/styling.js';

export const uploadCommand = defineCommand({
  meta: {
    name: 'upload',
    description: 'Upload an app binary to devicecloud.dev',
  },
  args: {
    ...apiFlags,
    'app-url': binaryFlags['app-url'],
    'ignore-sha-check': binaryFlags['ignore-sha-check'],
    debug: outputFlags.debug,
    json: outputFlags.json,
    appFile: {
      type: 'positional',
      required: false,
      description:
        'The binary file or Expo signed URL to upload (e.g. test.apk, test.app, test.zip, build.tar.gz, or https://expo.dev/...)',
    },
  },
  async run({ args }) {
    const tempFiles: string[] = [];
    const json = Boolean(args.json);
    // When --json is set, suppress chatty progress logs so stdout stays parseable.
    const out = (m: string) => {
      if (!json) logger.log(m);
    };
    try {
      const apiKeyFlag = args['api-key'] as string | undefined;
      const apiUrl = resolveApiUrl(args['api-url'] as string | undefined);
      const appUrl = args['app-url'] as string | undefined;
      const ignoreShaCheck = Boolean(args['ignore-sha-check']);
      const debug = Boolean(args.debug);
      const positional = args.appFile as string | undefined;

      const auth = await resolveAuth({ apiKeyFlag });

      let resolvedFile: string | undefined = appUrl ?? positional;
      if (!resolvedFile) {
        throw new CliError(
          'You must provide an app file path or a signed Expo URL via --app-url',
        );
      }

      if (isUrl(resolvedFile)) {
        out(`   ${colors.dim('→ Downloading Expo build from URL...')}`);
        const tarPath = await downloadExpoUrl(resolvedFile, debug);
        tempFiles.push(tarPath);
        resolvedFile = tarPath;
      }

      if (resolvedFile.endsWith('.tar.gz')) {
        out(`   ${colors.dim('→ Extracting Expo archive...')}`);
        const extractDir = await extractTarGz(resolvedFile, debug);
        tempFiles.push(extractDir);
        resolvedFile = await findAppBundle(extractDir);
        if (debug) {
          out(`[DEBUG] Found .app bundle at: ${resolvedFile}`);
        }
      }

      if (!['.apk', '.app', '.zip', '.tar.gz'].some((ext) => resolvedFile!.endsWith(ext))) {
        throw new CliError(
          'App file must be a .apk for Android, .app/.zip for iOS, or .tar.gz (Expo iOS build)',
        );
      }

      if (resolvedFile.endsWith('.zip')) {
        await verifyAppZip(resolvedFile);
      }

      out(sectionHeader('Uploading app binary'));
      out(`   ${colors.dim('→ File:')} ${colors.highlight(resolvedFile)}`);
      out('');

      const appBinaryId = await uploadBinary({
        auth,
        apiUrl,
        debug,
        filePath: resolvedFile,
        ignoreShaCheck,
        log: !json,
      });

      if (json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ appBinaryId }, null, 2));
        return;
      }

      logger.log(`\n${symbols.success} ${colors.bold('Upload complete')}`);
      logger.log(`   ${colors.dim('Binary ID:')} ${formatId(appBinaryId)}\n`);
      logger.log(colors.dim('You can use this Binary ID in subsequent test runs with:'));
      logger.log(colors.info(`dcd cloud --app-binary-id ${appBinaryId} path/to/flow.yaml\n`));
    } catch (error) {
      logger.error(error as Error, { exit: 1, json });
    } finally {
      for (const p of tempFiles) {
        await rm(p, { recursive: true, force: true }).catch(() => {});
      }
    }
  },
});

export default uploadCommand;
