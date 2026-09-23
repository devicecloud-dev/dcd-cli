import { expect } from 'chai';

import { DeviceValidationService } from '../../src/services/device-validation.service.js';
import { EiOSDevices } from '../../src/types/domain/device.types.js';
import type { CompatibilityData } from '../../src/utils/compatibility.js';

/**
 * Device names are validated against the API's live compatibility data, never
 * the CLI's help-text enums. `iphone-19` and `pixel-12` stand in for devices
 * the API has added since this CLI was released.
 */
const compat: CompatibilityData = {
  ios: {
    'iphone-14': ['17', '18'],
    'iphone-17': ['26', '27'],
    'iphone-19': ['28'],
    // A rollout gate can leave a device with nothing bookable.
    'iphone-gated': [],
  },
  android: {
    'pixel-7': ['33', '34', '35', '36', '37'],
    'pixel-10': ['36', '37'],
    'pixel-12': ['38'],
  },
  androidPlay: {
    'pixel-7': ['34'],
    'pixel-10': [],
    'pixel-12': [],
  },
  maestro: {
    defaultVersion: '2.2.0',
    latestVersion: '2.10.0',
    supportedVersions: ['2.2.0', '2.10.0'],
  },
};

const MCP_ARG_NAMES = {
  androidApiLevel: 'androidApiLevel',
  androidDevice: 'androidDevice',
  iOSDevice: 'iosDevice',
  iOSVersion: 'iosVersion',
};

describe('DeviceValidationService', () => {
  const service = new DeviceValidationService();
  const ios = (version?: string, device?: string, data = compat) =>
    service.validateiOSDevice(version, device, data);
  const android = (
    apiLevel?: string,
    device?: string,
    googlePlay = false,
    data = compat,
  ) => service.validateAndroidDevice(apiLevel, device, googlePlay, data);

  describe('devices the CLI does not know about', () => {
    it('accepts an iOS device and version the API offers but the CLI enum lacks', () => {
      expect(Object.values(EiOSDevices)).to.not.include('iphone-19');
      expect(() => ios('28', 'iphone-19')).to.not.throw();
    });

    it('accepts an Android device and API level the API offers but the CLI enum lacks', () => {
      expect(() => android('38', 'pixel-12')).to.not.throw();
    });
  });

  describe('unknown devices', () => {
    it('rejects an unknown iOS device, listing what the API offers in its order', () => {
      expect(() => ios('17', 'iphone-99')).to.throw(
        'iOS device "iphone-99" is not supported. Supported iOS devices: iphone-14, iphone-17, iphone-19. See https://docs.devicecloud.dev/getting-started/devices-configuration',
      );
    });

    it('never offers a gated device, and treats it as unsupported', () => {
      expect(() => ios('17', 'iphone-gated')).to.throw(
        /iOS device "iphone-gated" is not supported\. Supported iOS devices: iphone-14, iphone-17, iphone-19\./,
      );
    });

    it('rejects an unknown Android device, listing the Android devices', () => {
      expect(() => android('34', 'pixel-99')).to.throw(
        /Android device "pixel-99" is not supported\. Supported Android devices: pixel-7, pixel-10, pixel-12\./,
      );
    });

    it('says a real device has no Google Play image, listing the Play devices', () => {
      expect(() => android('36', 'pixel-10', true)).to.throw(
        /Android device "pixel-10" is not available with Google Play\. Google Play devices: pixel-7\./,
      );
    });

    it('lists only Google Play devices for an unknown device with --google-play', () => {
      expect(() => android('34', 'pixel-99', true)).to.throw(
        /Android device "pixel-99" is not supported\. Supported Google Play devices: pixel-7\./,
      );
    });

    it('does not resolve a prototype member as a device', () => {
      expect(() => ios('17', 'constructor')).to.throw(
        /iOS device "constructor" is not supported/,
      );
    });

    it('still fails when the API sent no list at all, without an empty list', () => {
      const noIos = { ...compat, ios: {} };
      expect(() => ios('17', 'iphone-14', noIos)).to.throw(
        'iOS device "iphone-14" is not supported. See https://docs.devicecloud.dev/getting-started/devices-configuration',
      );
    });
  });

  describe('versions', () => {
    it('accepts a supported pair', () => {
      expect(() => ios('26', 'iphone-17')).to.not.throw();
      expect(() => android('34', 'pixel-7', true)).to.not.throw();
    });

    it('rejects an unsupported explicit pair with the device\'s versions', () => {
      expect(() => ios('27', 'iphone-14')).to.throw(
        /^iphone-14 only supports these iOS versions: 17, 18$/,
      );
      expect(() => android('34', 'pixel-10')).to.throw(
        /^pixel-10 only supports these Android API levels: 36, 37$/,
      );
    });

    it('does nothing when neither a device nor a version was requested', () => {
      expect(() => ios()).to.not.throw();
      expect(() => android(undefined, undefined, true)).to.not.throw();
    });
  });

  // The API fills an omitted half from the same global defaults (iphone-14 /
  // iOS 17, pixel-7 / API 34) and rejects an incompatible pair, so the CLI
  // mirrors that — but must tell the user to pass the other half.
  describe('requests that rely on a default', () => {
    it('tells a device-only iOS request to pass the version explicitly', () => {
      expect(() => ios(undefined, 'iphone-17')).to.throw(
        'iphone-17 only supports these iOS versions: 26, 27. No iOS version was given, so the default (17) was checked: pass one of those explicitly with --ios-version',
      );
    });

    it('tells a device-only Android request to pass the API level explicitly', () => {
      expect(() => android(undefined, 'pixel-10')).to.throw(
        'pixel-10 only supports these Android API levels: 36, 37. No Android API level was given, so the default (34) was checked: pass one of those explicitly with --android-api-level',
      );
    });

    it('accepts a device-only request when the default version fits', () => {
      expect(() => ios(undefined, 'iphone-14')).to.not.throw();
      expect(() => android(undefined, 'pixel-7')).to.not.throw();
    });

    it('names the MCP tool parameters when asked to', () => {
      expect(() =>
        service.validateiOSDevice(undefined, 'iphone-17', compat, {
          argNames: MCP_ARG_NAMES,
        }),
      ).to.throw(/pass one of those explicitly with iosVersion$/);
      expect(() =>
        service.validateAndroidDevice('38', undefined, false, compat, {
          argNames: MCP_ARG_NAMES,
        }),
      ).to.throw(/with androidDevice: pixel-12$/);
    });

    it('points a version-only request at the devices that offer that version', () => {
      expect(() => ios('27')).to.throw(
        'iphone-14 only supports these iOS versions: 17, 18. No iOS device was given, so the default (iphone-14) was checked: pass one that offers iOS 27 with --ios-device: iphone-17',
      );
    });

    it('says when no device offers the requested version at all', () => {
      expect(() => ios('99')).to.throw(
        /No iOS device was given, so the default \(iphone-14\) was checked: no iOS device offers iOS 99$/,
      );
      expect(() => android('36', undefined, true)).to.throw(
        /no Google Play device offers API level 36$/,
      );
    });

    it('leaves a version-only request to the API once the API no longer offers the assumed default device', () => {
      // The API has moved its default on; checking against the CLI's stale
      // assumption would refuse a request the API accepts.
      const withoutPixel7 = {
        ...compat,
        android: { 'pixel-10': ['36', '37'] },
      };
      expect(() => android('36', undefined, false, withoutPixel7)).to.not.throw();
    });
  });
});
