import {
  DeviceMatrixConfig,
  isIosMatrixConfig,
} from '../types/domain/device.types.js';
import { CliError } from './cli.js';

/**
 * Parse repeated `--ios-config <device>:<version>` and
 * `--android-config <device>:<apiLevel>[:play]` flags into an explicit device
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
      'A device matrix cannot mix platforms: use either --ios-config or --android-config, not both. One upload runs one binary.',
    );
  }

  const configs: DeviceMatrixConfig[] = [];

  for (const raw of iosConfigs) {
    const parts = raw.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new CliError(
        `Invalid --ios-config "${raw}". Expected <device>:<version>, e.g. iphone-16:18.`,
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
        `Invalid --android-config "${raw}". Expected <device>:<apiLevel> or <device>:<apiLevel>:play, e.g. pixel-7:34 or pixel-7:34:play.`,
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
