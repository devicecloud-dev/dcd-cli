import type { CompatibilityData } from '../utils/compatibility.js';

const DEVICES_DOCS_URL =
  'https://docs.devicecloud.dev/getting-started/devices-configuration';

/** The device / OS inputs a caller exposes, named for "pass it explicitly" hints. */
export interface DeviceArgNames {
  androidApiLevel: string;
  androidDevice: string;
  iOSDevice: string;
  iOSVersion: string;
}

/** `dcd cloud`'s spelling; the MCP tool passes its own parameter names. */
const CLI_ARG_NAMES: DeviceArgNames = {
  androidApiLevel: '--android-api-level',
  androidDevice: '--android-device',
  iOSDevice: '--ios-device',
  iOSVersion: '--ios-version',
};

export interface DeviceValidationOptions {
  /** How the caller names its inputs in error hints. Defaults to the CLI flags. */
  argNames?: DeviceArgNames;
  debug?: boolean;
  logger?: (message: string) => void;
}

/** Device slug → the OS versions the API will run it on. */
type CompatibilityLookup = Record<string, string[]> | undefined;

/** The versions a lookup offers for one device; empty when it offers none. */
function versionsFor(lookup: CompatibilityLookup, device: string): string[] {
  // hasOwn, so a slug like "constructor" can't resolve to a prototype member.
  if (!lookup || !Object.hasOwn(lookup, device)) return [];
  const versions = lookup[device];
  return Array.isArray(versions) ? versions : [];
}

/**
 * Devices the lookup can actually run, in the API's order. A rollout gate can
 * leave a device with no versions (every non-Play device has an empty Google
 * Play list), and those must not be offered as alternatives.
 */
function offeredDevices(lookup: CompatibilityLookup): string[] {
  return Object.keys(lookup ?? {}).filter(
    (device) => versionsFor(lookup, device).length > 0,
  );
}

/**
 * Validates requested devices against the compatibility matrix the API serves
 * from `GET /results/compatibility/data`, which is the only authority on what
 * can run. Nothing here consults the CLI's device and OS enums
 * (src/types/domain/device.types.ts) — those only feed `--help` — so a device
 * or OS version the API adds is accepted without a CLI release, and one it
 * withdraws is refused, before anything is uploaded, with the list the API
 * offers today.
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
    const lookup = googlePlay
      ? compatibilityData.androidPlay
      : compatibilityData.android;
    const argNames = options.argNames ?? CLI_ARG_NAMES;

    this.validateDevice({
      debugLines: (deviceID, version, supportedVersions) => [
        `[DEBUG] Android device: ${deviceID}`,
        `[DEBUG] Android API level: ${version}`,
        `[DEBUG] Google Play enabled: ${googlePlay}`,
        `[DEBUG] Supported Android versions: ${supportedVersions.join(', ')}`,
      ],
      // Mirrors the API, which applies these same global defaults to a
      // request that omits either half (test-request-validator.service.ts)
      // and then rejects an incompatible pair.
      defaultDevice: 'pixel-7',
      defaultVersion: '34',
      device: androidDevice,
      deviceArg: argNames.androidDevice,
      deviceKind: googlePlay ? 'Google Play' : 'Android',
      formatVersion: (version) => `API level ${version}`,
      lookup,
      options,
      platform: 'Android',
      // A real device that merely has no Google Play image deserves a sharper
      // answer than "not supported".
      unknownDeviceMessage: (deviceID) =>
        googlePlay && versionsFor(compatibilityData.android, deviceID).length > 0
          ? `Android device "${deviceID}" is not available with Google Play. Google Play devices: ${offeredDevices(lookup).join(', ')}. See ${DEVICES_DOCS_URL}`
          : undefined,
      unsupportedVersionMessage: (deviceID, supportedVersions) =>
        `${deviceID} ${
          googlePlay ? '(Play Store) ' : ''
        }only supports these Android API levels: ${supportedVersions.join(', ')}`,
      version: androidApiLevel,
      versionArg: argNames.androidApiLevel,
      versionName: 'Android API level',
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
    const argNames = options.argNames ?? CLI_ARG_NAMES;

    this.validateDevice({
      debugLines: (deviceID, version, supportedVersions) => [
        `[DEBUG] iOS device: ${deviceID}`,
        `[DEBUG] iOS version: ${version}`,
        `[DEBUG] Supported iOS versions: ${supportedVersions.join(', ')}`,
      ],
      // Mirrors the API's global defaults, as for Android above.
      defaultDevice: 'iphone-14',
      defaultVersion: '17',
      device: iOSDevice,
      deviceArg: argNames.iOSDevice,
      deviceKind: 'iOS',
      formatVersion: (version) => `iOS ${version}`,
      lookup: compatibilityData?.ios,
      options,
      platform: 'iOS',
      unsupportedVersionMessage: (deviceID, supportedVersions) =>
        `${deviceID} only supports these iOS versions: ${supportedVersions.join(', ')}`,
      version: iOSVersion,
      versionArg: argNames.iOSVersion,
      versionName: 'iOS version',
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
    /** How the caller names the device input, e.g. "--ios-device". */
    deviceArg: string;
    /** What the offered-device list is called: "iOS", "Android", "Google Play". */
    deviceKind: string;
    /** One version in prose, e.g. "iOS 27" or "API level 37". */
    formatVersion: (version: string) => string;
    lookup: CompatibilityLookup;
    options: DeviceValidationOptions;
    platform: 'Android' | 'iOS';
    /** Replaces the generic unknown-device message when it returns a string. */
    unknownDeviceMessage?: (deviceID: string) => string | undefined;
    unsupportedVersionMessage: (
      deviceID: string,
      supportedVersions: string[],
    ) => string;
    version: string | undefined;
    /** How the caller names the version input, e.g. "--ios-version". */
    versionArg: string;
    /** e.g. "iOS version" / "Android API level". */
    versionName: string;
  }): void {
    const {
      debugLines,
      defaultDevice,
      defaultVersion,
      device,
      deviceArg,
      deviceKind,
      formatVersion,
      lookup,
      options,
      platform,
      unknownDeviceMessage,
      unsupportedVersionMessage,
      version,
      versionArg,
      versionName,
    } = config;
    const { debug = false, logger } = options;

    if (!version && !device) {
      return;
    }

    const deviceID = device || defaultDevice;
    const supportedVersions = versionsFor(lookup, deviceID);
    const requestedVersion = version || defaultVersion;

    if (supportedVersions.length === 0) {
      if (!device) {
        // Only a version was requested, and the API no longer offers the
        // device the CLI assumes it defaults to. That assumption is what's
        // stale, not the request: the API resolves and validates its own
        // default device when the run is submitted.
        if (debug && logger) {
          logger(
            `[DEBUG] Default ${platform} device ${deviceID} is not in the compatibility data; leaving the ${versionName} check to the API`,
          );
        }

        return;
      }

      const offered = offeredDevices(lookup);
      throw new Error(
        unknownDeviceMessage?.(deviceID) ??
          (offered.length > 0
            ? `${platform} device "${deviceID}" is not supported. Supported ${deviceKind} devices: ${offered.join(', ')}. See ${DEVICES_DOCS_URL}`
            : `${platform} device "${deviceID}" is not supported. See ${DEVICES_DOCS_URL}`),
      );
    }

    if (!supportedVersions.includes(requestedVersion)) {
      const unsupported = unsupportedVersionMessage(deviceID, supportedVersions);

      if (!version) {
        // Device-only request. The API fills in the same global default
        // version rather than one this device runs, so the submission would
        // be refused there too — say so, and how to avoid it.
        throw new Error(
          `${unsupported}. No ${versionName} was given, so the default (${defaultVersion}) was checked: pass one of those explicitly with ${versionArg}`,
        );
      }

      if (!device) {
        // Version-only request: name the device that was assumed, and the
        // devices that do offer the requested version.
        const devicesWithVersion = offeredDevices(lookup).filter((d) =>
          versionsFor(lookup, d).includes(requestedVersion),
        );
        throw new Error(
          `${unsupported}. No ${platform} device was given, so the default (${deviceID}) was checked: ` +
            (devicesWithVersion.length > 0
              ? `pass one that offers ${formatVersion(requestedVersion)} with ${deviceArg}: ${devicesWithVersion.join(', ')}`
              : `no ${deviceKind} device offers ${formatVersion(requestedVersion)}`),
        );
      }

      throw new Error(unsupported);
    }

    if (debug && logger) {
      for (const line of debugLines(deviceID, requestedVersion, supportedVersions)) {
        logger(line);
      }
    }
  }
}
