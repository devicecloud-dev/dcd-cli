/**
 * `@devicecloud.dev/dcd/e2e`: run e2e (https://github.com/e2e-inc/e2e) tests
 * on DeviceCloud devices.
 *
 *   import { mobile } from '@e2e-dev/mobile';
 *   import { deviceCloud } from '@devicecloud.dev/dcd/e2e';
 *
 *   const engine = mobile({ platform: 'android', device: deviceCloud() });
 *
 * Each e2e worker gets its own DeviceCloud device session, which shows in the
 * console, is recorded, and is billed like any other. Reads
 * `DEVICE_CLOUD_API_KEY` from the run's environment. Early access: the
 * organization needs it turned on by DeviceCloud.
 *
 * Importing this module has no side effects; it does not start the CLI.
 */
import { uploadLocalApp } from '../utils/app-upload.js';
import { getCliVersion } from '../utils/cli.js';

import {
  createProvider,
  type DeviceCloudOptions,
  type DeviceCloudProvider,
} from './provider.js';

export type {
  DeviceCloudOptions,
  DeviceCloudProvider,
  E2eDeviceLease,
  E2eDeviceRequest,
  E2eReleaseContext,
} from './provider.js';

/** A DeviceCloud device provider, for `mobile({ device })` in an e2e config. */
export function deviceCloud(
  options: DeviceCloudOptions = {},
): DeviceCloudProvider {
  return createProvider(options, {
    fetch: (input, init) => fetch(input, init),
    pollMs: 3000,
    startTimeoutMs: 20 * 60_000,
    upload: ({ apiKey, apiUrl, filePath, log }) =>
      uploadLocalApp({
        apiUrl,
        auth: {
          headers: {
            'x-app-api-key': apiKey,
            'x-dcd-cli-version': getCliVersion(),
          },
          mode: 'apiKey',
        },
        filePath,
        log,
        showProgress: false,
      }),
    version: getCliVersion(),
  });
}
