import {
  DeviceMatrixConfig,
  isIosMatrixConfig,
} from '../types/domain/device.types.js';
import { CliError } from './cli.js';

/**
 * Refuse to submit a device matrix to an API that cannot honour it.
 *
 * The estimate endpoint is only called when a matrix was actually requested, so
 * a null estimate (the gateway maps 404/405 to null) means the API predates the
 * feature. That API would **silently strip** the unknown `deviceMatrix` field —
 * its ValidationPipe runs `whitelist: true, forbidNonWhitelisted: false` — and
 * run every flow on a single default device, exiting 0. The user would believe
 * they had tested N devices when they tested one: the exact silent
 * under-testing the device matrix exists to prevent. Fail loudly instead.
 *
 * @throws CliError when a matrix was requested but the API does not support it.
 */
export function assertMatrixSupported(
  deviceMatrix: DeviceMatrixConfig[],
  estimate: unknown | null,
): void {
  if (deviceMatrix.length === 0 || estimate) return;

  throw new CliError(
    'This DeviceCloud API does not support device matrices, so ' +
      '--ios-device-matrix / --android-device-matrix cannot be honoured. ' +
      'Submitting anyway would silently run every flow on a single default ' +
      'device and report success. Upgrade the API, or drop the matrix flags ' +
      'and use --ios-device / --android-device for a single-device run.',
  );
}

/**
 * Parse repeated `--ios-device-matrix <device>:<version>` and
 * `--android-device-matrix <device>:<apiLevel>[:play]` flags into an explicit device
 * matrix. Each entry is one validated cell — there is NO cross-product, because
 * the compatibility matrix is ragged and a cross-product would invent cells the
 * user never asked for.
 *
 * A device matrix is single-platform (one upload, one binary), so mixing iOS
 * and Android configs is rejected here before anything is uploaded.
 *
 * @throws CliError on malformed syntax or a mixed-platform matrix.
 */
export function parseDeviceMatrix(
  iosConfigs: string[],
  androidConfigs: string[],
): DeviceMatrixConfig[] {
  if (iosConfigs.length > 0 && androidConfigs.length > 0) {
    throw new CliError(
      'A device matrix cannot mix platforms: use either --ios-device-matrix or --android-device-matrix, not both. One upload runs one binary.',
    );
  }

  const configs: DeviceMatrixConfig[] = [];

  for (const raw of iosConfigs) {
    const parts = raw.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new CliError(
        `Invalid --ios-device-matrix "${raw}". Expected <device>:<version>, e.g. iphone-16:18.`,
      );
    }
    configs.push({ iOSDevice: parts[0], iOSVersion: parts[1] });
  }

  for (const raw of androidConfigs) {
    const parts = raw.split(':');
    // <device>:<apiLevel> with an optional trailing :play for a Play cell.
    if (
      parts.length < 2 ||
      parts.length > 3 ||
      !parts[0] ||
      !parts[1] ||
      (parts.length === 3 && parts[2] !== 'play')
    ) {
      throw new CliError(
        `Invalid --android-device-matrix "${raw}". Expected <device>:<apiLevel> or <device>:<apiLevel>:play, e.g. pixel-7:34 or pixel-7:34:play.`,
      );
    }
    configs.push({
      androidDevice: parts[0],
      androidApiLevel: parts[1],
      ...(parts.length === 3 ? { googlePlay: true } : {}),
    });
  }

  return configs;
}

/** True when the matrix targets iOS (used to pick the validation lookup). */
export function matrixIsIos(configs: DeviceMatrixConfig[]): boolean {
  return configs.length > 0 && isIosMatrixConfig(configs[0]);
}
