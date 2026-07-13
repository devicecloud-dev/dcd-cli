import type { ArgsDef } from 'citty';

import {
  EAndroidApiLevels,
  EAndroidDevices,
  EiOSDevices,
  EiOSVersions,
} from '../../types/domain/device.types.js';

const androidApiLevels = Object.values(EAndroidApiLevels).join(', ');
const androidDevices = Object.values(EAndroidDevices).join(', ');
const iosDevices = Object.values(EiOSDevices).join(', ');
const iosVersions = Object.values(EiOSVersions).join(', ');

/**
 * Device-specific flags for Android and iOS configuration
 */
export const deviceFlags = {
  'android-api-level': {
    type: 'string',
    description: `[Android only] Android API level to run your flow against (options: ${androidApiLevels})`,
  },
  'android-device': {
    type: 'string',
    description: `[Android only] Android device to run your flow against (options: ${androidDevices})`,
  },
  'device-locale': {
    type: 'string',
    description:
      'Locale that will be set to a device, ISO-639-1 code and uppercase ISO-3166-1 code e.g. "de_DE" for Germany',
  },
  'google-play': {
    type: 'boolean',
    default: false,
    description: '[Android only] Run your flow against Google Play devices',
  },
  'ios-device': {
    type: 'string',
    description: `[iOS only] iOS device to run your flow against (options: ${iosDevices})`,
  },
  'ios-version': {
    type: 'string',
    description: `[iOS only] iOS version to run your flow against (options: ${iosVersions})`,
  },
  'ios-device-matrix': {
    type: 'string',
    description: `[iOS only] Device-matrix cell as <device>:<version>, e.g. iphone-16:18. Repeatable — every flow runs once per cell (no cross-product). Cannot be combined with --android-device-matrix.`,
  },
  'android-device-matrix': {
    type: 'string',
    description: `[Android only] Device-matrix cell as <device>:<apiLevel> (append :play for Google Play), e.g. pixel-7:34 or pixel-7:34:play. Repeatable — every flow runs once per cell (no cross-product). Cannot be combined with --ios-device-matrix.`,
  },
  orientation: {
    type: 'string',
    description:
      '[Android only] The orientation of the device to run your flow against (0 = portrait, 90 = landscape)',
  },
  'show-crosshairs': {
    type: 'boolean',
    default: false,
    description:
      '[Android only] Display crosshairs for screen interactions during test execution',
  },
  'maestro-chrome-onboarding': {
    type: 'boolean',
    default: false,
    description:
      '[Android only] Force Maestro-based Chrome onboarding - note: this will slow your tests but can fix browser related crashes. See https://docs.devicecloud.dev/advanced/chrome-onboarding for more information.',
  },
  'android-no-snapshot': {
    type: 'boolean',
    default: false,
    description:
      '[Android only] Force cold boot instead of using snapshot boot. This is automatically enabled for API 35+ but can be used to force cold boot on older API levels.',
  },
  'disable-animations': {
    type: 'boolean',
    default: false,
    description:
      'Disable device animations during test execution. On Android, disables system animation scales. On iOS, enables Reduce Motion. Reduces CPU load and may improve test reliability.',
  },
} as const satisfies ArgsDef;
