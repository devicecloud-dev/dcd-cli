/**
 * Device type definitions - should be kept in sync with API
 * @see dcd/api/src/common/types/device.types.ts
 *
 * These drive `--ios-device` / `--android-device` help text and nothing else:
 * the actual validation runs against the live compatibility payload
 * (device-validation.service.ts), so a value the API has dropped produces a
 * clear "not supported" error rather than a wrong local rejection. That makes
 * a CLI *ahead* of the API safe and a CLI *behind* it not.
 *
 * `iphone-14-pro` and `iphone-15-pro` were listed here but have never existed
 * in the API enum; removed 2026-09-21 rather than carried forward.
 */

export enum EiOSDevices {
  'ipad-pro-6th-gen' = 'ipad-pro-6th-gen',
  'ipad-pro-m5-11' = 'ipad-pro-m5-11',
  'ipad-pro-m5-13' = 'ipad-pro-m5-13',
  'iphone-14' = 'iphone-14',
  'iphone-15' = 'iphone-15',
  'iphone-16' = 'iphone-16',
  'iphone-16-plus' = 'iphone-16-plus',
  'iphone-16-pro' = 'iphone-16-pro',
  'iphone-16-pro-max' = 'iphone-16-pro-max',
  'iphone-17' = 'iphone-17',
  'iphone-18-pro' = 'iphone-18-pro',
  'iphone-18-pro-max' = 'iphone-18-pro-max',
  'iphone-air' = 'iphone-air',
}

export enum EAndroidDevices {
  'generic-tablet' = 'generic-tablet',
  'pixel-6' = 'pixel-6',
  'pixel-6-pro' = 'pixel-6-pro',
  'pixel-7' = 'pixel-7',
  'pixel-7-pro' = 'pixel-7-pro',
  'pixel-8' = 'pixel-8',
  'pixel-10' = 'pixel-10',
  'pixel-10-pro' = 'pixel-10-pro',
  'pixel-10-pro-xl' = 'pixel-10-pro-xl',
  'pixel-10-pro-fold' = 'pixel-10-pro-fold',
  'pixel-11' = 'pixel-11',
}

export enum EiOSVersions {
  'eighteen' = '18',
  'seventeen' = '17',
  'twentySeven' = '27',
  'twentySix' = '26',
}

export enum EAndroidApiLevels {
  'thirty' = '30',
  'thirtyFive' = '35',
  'thirtyFour' = '34',
  'thirtyOne' = '31',
  'thirtySeven' = '37',
  'thirtySix' = '36',
  'thirtyThree' = '33',
  'thirtyTwo' = '32',
  'twentyNine' = '29',
}

/**
 * One explicit device-matrix cell. iOS entries carry {iOSDevice, iOSVersion};
 * Android entries carry {androidDevice, androidApiLevel} plus an optional Play
 * channel. Sent to the API as the `deviceMatrix` array; every non-targeted flow
 * runs once per cell. There is no cross-product — each entry is one cell.
 */
export type DeviceMatrixConfig =
  | { iOSDevice: string; iOSVersion: string }
  | { androidApiLevel: string; androidDevice: string; googlePlay?: boolean };

export const isIosMatrixConfig = (
  c: DeviceMatrixConfig,
): c is { iOSDevice: string; iOSVersion: string } => 'iOSDevice' in c;
