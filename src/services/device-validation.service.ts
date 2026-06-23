import { EAndroidDevices, EiOSDevices } from '../types/domain/device.types.js';
import { CompatibilityData } from '../utils/compatibility.js';

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
    this.validateDevice({
      debugLines: (deviceID, version, supportedVersions) => [
        `[DEBUG] Android device: ${deviceID}`,
        `[DEBUG] Android API level: ${version}`,
        `[DEBUG] Google Play enabled: ${googlePlay}`,
        `[DEBUG] Supported Android versions: ${supportedVersions.join(', ')}`,
      ],
      defaultDevice: 'pixel-7',
      defaultVersion: '34',
      device: androidDevice as EAndroidDevices | undefined,
      lookup: googlePlay
        ? compatibilityData.androidPlay
        : compatibilityData.android,
      noSupportMessage: () =>
        `We don't support that device configuration - please check the docs for supported devices: https://docs.devicecloud.dev/getting-started/devices-configuration`,
      options,
      unsupportedVersionMessage: (deviceID, supportedVersions) =>
        `${deviceID} ${
          googlePlay ? '(Play Store) ' : ''
        }only supports these Android API levels: ${supportedVersions.join(', ')}`,
      version: androidApiLevel,
    });
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
    this.validateDevice({
      debugLines: (deviceID, version, supportedVersions) => [
        `[DEBUG] iOS device: ${deviceID}`,
        `[DEBUG] iOS version: ${version}`,
        `[DEBUG] Supported iOS versions: ${supportedVersions.join(', ')}`,
      ],
      defaultDevice: 'iphone-14',
      defaultVersion: '17',
      device: iOSDevice as EiOSDevices | undefined,
      lookup: compatibilityData?.ios,
      noSupportMessage: (deviceID) =>
        `Device ${deviceID} is not supported. Please check the docs for supported devices: https://docs.devicecloud.dev/getting-started/devices-configuration`,
      options,
      unsupportedVersionMessage: (deviceID, supportedVersions) =>
        `${deviceID} only supports these iOS versions: ${supportedVersions.join(', ')}`,
      version: iOSVersion,
    });
  }

  /**
   * Shared validation flow for both platforms: apply the default device,
   * look up its supported versions, then check the requested version
   * @param config Platform-specific lookup table, defaults, and messages
   * @returns void
   * @throws Error if device/version combination is not supported
   */
  private validateDevice(config: {
    debugLines: (
      deviceID: string,
      version: string,
      supportedVersions: string[],
    ) => string[];
    defaultDevice: string;
    defaultVersion: string;
    device: string | undefined;
    lookup: Record<string, string[]> | undefined;
    noSupportMessage: (deviceID: string) => string;
    options: DeviceValidationOptions;
    unsupportedVersionMessage: (
      deviceID: string,
      supportedVersions: string[],
    ) => string;
    version: string | undefined;
  }): void {
    const {
      debugLines,
      defaultDevice,
      defaultVersion,
      device,
      lookup,
      noSupportMessage,
      options,
      unsupportedVersionMessage,
      version,
    } = config;
    const { debug = false, logger } = options;

    if (!version && !device) {
      return;
    }

    const deviceID = device || defaultDevice;
    const supportedVersions: string[] = lookup?.[deviceID] || [];
    const requestedVersion = version || defaultVersion;

    if (supportedVersions.length === 0) {
      throw new Error(noSupportMessage(deviceID));
    }

    if (
      Array.isArray(supportedVersions) &&
      !supportedVersions.includes(requestedVersion)
    ) {
      throw new Error(unsupportedVersionMessage(deviceID, supportedVersions));
    }

    if (debug && logger) {
      for (const line of debugLines(deviceID, requestedVersion, supportedVersions)) {
        logger(line);
      }
    }
  }
}
