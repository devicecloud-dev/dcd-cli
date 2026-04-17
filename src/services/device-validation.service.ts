import { EAndroidDevices, EiOSDevices } from '../types/domain/device.types';
import { CompatibilityData } from '../utils/compatibility';

export interface DeviceValidationOptions {
  debug?: boolean;
  logger?: (message: string) => void;
}

/**
 * Service for validating device configurations against compatibility data
 */
export class DeviceValidationService {
  /**
   * Validate Android device configuration
   * @param androidApiLevel Android API level to validate
   * @param androidDevice Android device model to validate
   * @param googlePlay Whether Google Play services are enabled
   * @param compatibilityData Compatibility data from API
   * @param options Validation options
   * @returns void
   * @throws Error if device/API level combination is not supported
   */
  public validateAndroidDevice(
    androidApiLevel: string | undefined,
    androidDevice: string | undefined,
    googlePlay: boolean,
    compatibilityData: CompatibilityData,
    options: DeviceValidationOptions = {},
  ): void {
    const { debug = false, logger } = options;

    if (!androidApiLevel && !androidDevice) {
      return;
    }

    const androidDeviceID = androidDevice || 'pixel-7';
    const lookup = googlePlay
      ? compatibilityData.androidPlay
      : compatibilityData.android;
    const supportedAndroidVersions: string[] =
      lookup?.[androidDeviceID as EAndroidDevices] || [];
    const version = androidApiLevel || '34';

    if (supportedAndroidVersions.length === 0) {
      throw new Error(
        `We don't support that device configuration - please check the docs for supported devices: https://docs.devicecloud.dev/getting-started/devices-configuration`,
      );
    }

    if (
      Array.isArray(supportedAndroidVersions) &&
      !supportedAndroidVersions.includes(version)
    ) {
      throw new Error(
        `${androidDeviceID} ${
          googlePlay ? '(Play Store) ' : ''
        }only supports these Android API levels: ${supportedAndroidVersions.join(
          ', ',
        )}`,
      );
    }

    if (debug && logger) {
      logger(`[DEBUG] Android device: ${androidDeviceID}`);
      logger(`[DEBUG] Android API level: ${version}`);
      logger(`[DEBUG] Google Play enabled: ${googlePlay}`);
      logger(
        `[DEBUG] Supported Android versions: ${supportedAndroidVersions.join(
          ', ',
        )}`,
      );
    }
  }

  /**
   * Validate iOS device configuration
   * @param iOSVersion iOS version to validate
   * @param iOSDevice iOS device model to validate
   * @param compatibilityData Compatibility data from API
   * @param options Validation options
   * @returns void
   * @throws Error if device/version combination is not supported
   */
  public validateiOSDevice(
    iOSVersion: string | undefined,
    iOSDevice: string | undefined,
    compatibilityData: CompatibilityData,
    options: DeviceValidationOptions = {},
  ): void {
    const { debug = false, logger } = options;

    if (!iOSVersion && !iOSDevice) {
      return;
    }

    const iOSDeviceID = iOSDevice || 'iphone-14';
    const supportediOSVersions: string[] =
      compatibilityData?.ios?.[iOSDeviceID as EiOSDevices] || [];
    const version = iOSVersion || '17';

    if (supportediOSVersions.length === 0) {
      throw new Error(
        `Device ${iOSDeviceID} is not supported. Please check the docs for supported devices: https://docs.devicecloud.dev/getting-started/devices-configuration`,
      );
    }

    if (
      Array.isArray(supportediOSVersions) &&
      !supportediOSVersions.includes(version)
    ) {
      throw new Error(
        `${iOSDeviceID} only supports these iOS versions: ${supportediOSVersions.join(
          ', ',
        )}`,
      );
    }

    if (debug && logger) {
      logger(`[DEBUG] iOS device: ${iOSDeviceID}`);
      logger(`[DEBUG] iOS version: ${version}`);
      logger(
        `[DEBUG] Supported iOS versions: ${supportediOSVersions.join(', ')}`,
      );
    }
  }
}
