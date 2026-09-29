import { defineCommand } from 'citty';
import { rm } from 'node:fs/promises';

import { apiFlags } from '../config/flags/api.flags.js';
import { binaryFlags } from '../config/flags/binary.flags.js';
import { outputFlags } from '../config/flags/output.flags.js';
import { uploadBinary, verifyAppZip } from '../methods.js';
import { resolveAuth } from '../utils/auth.js';
import { detectCiContext } from '../utils/ci.js';
import { CliError, getCliVersion, logger } from '../utils/cli.js';
import { fetchCompatibilityData } from '../utils/compatibility.js';
import { resolveApiUrl } from '../utils/config-store.js';
import { resolveEncryption } from '../utils/envelope.js';
import { downloadExpoUrl, extractTarGz, findAppBundle, isUrl } from '../utils/expo.js';
import { colors, formatId } from '../utils/styling.js';
import { ui } from '../utils/ui.js';

export const uploadCommand = defineCommand({
  meta: {
    name: 'upload',
    description: 'Upload an app binary to devicecloud.dev',
  },
  args: {
    ...apiFlags,
    'app-url': binaryFlags['app-url'],
    'ignore-sha-check': binaryFlags['ignore-sha-check'],
    encrypt: binaryFlags.encrypt,
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
      // Kept as given, so --no-encrypt is an explicit false and a missing flag
      // leaves DCD_ENCRYPT and then the org's default to decide.
      const encryptFlag = args.encrypt as boolean | undefined;
      const debug = Boolean(args.debug);
      const positional = args.appFile as string | undefined;

      const auth = await resolveAuth({ apiKeyFlag });

      // Same order as `dcd cloud`, whose compatibility fetch carries the org's
      // encryption default. `dcd upload` never needed that data before, so a
      // failed fetch leaves the default off rather than failing the upload.
      let serverDefault: boolean | undefined;
      try {
        const ciContext = detectCiContext();
        const compatibilityData = await fetchCompatibilityData(apiUrl, auth, {
          cliVersion: getCliVersion(),
          ciProvider: ciContext.provider,
          ciWrapperVersion: ciContext.wrapperVersion,
        });
        serverDefault = compatibilityData.encryption?.defaultOn;
      } catch (error) {
        if (debug) {
          out(
            `[DEBUG] Failed to fetch compatibility data, so the org's encryption default is off: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const encryption = resolveEncryption({ flag: encryptFlag, serverDefault });

      let resolvedFile: string | undefined = appUrl ?? positional;
      if (!resolvedFile) {
        throw new CliError(
          'You must provide an app file path or a signed Expo URL via --app-url',
        );
      }

      if (isUrl(resolvedFile)) {
        out(ui.running('Downloading Expo build from URL…'));
        const tarPath = await downloadExpoUrl(resolvedFile, debug);
        tempFiles.push(tarPath);
        resolvedFile = tarPath;
      }

      if (resolvedFile.endsWith('.tar.gz')) {
        out(ui.running('Extracting Expo archive…'));
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

      out(ui.section('Uploading app binary'));
      out(
        ui.branch([
          ...ui.fields([['file', colors.highlight(resolvedFile)]]),
          ...(encryption.enabled && encryption.source === 'server'
            ? [ui.note('Encrypting uploads (beta); opt out with --no-encrypt')]
            : []),
        ]),
      );

      const appBinaryId = await uploadBinary({
        auth,
        apiUrl,
        debug,
        encrypt: encryption.enabled,
        filePath: resolvedFile,
        ignoreShaCheck,
        log: !json,
      });

      if (json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ appBinaryId }, null, 2));
        return;
      }

      logger.log(`\n${ui.success('Upload complete')}`);
      logger.log(
        ui.branch([
          ...ui.fields([['binary id', formatId(appBinaryId)]]),
          ui.note('Use this Binary ID in subsequent test runs with:'),
          colors.info(`dcd cloud --app-binary-id ${appBinaryId} path/to/flow.yaml`),
        ]),
      );
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
