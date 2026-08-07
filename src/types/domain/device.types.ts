/**
 * Device type definitions - should be kept in sync with API
 * @see /Users/riglar/repos/dcd/api/src/common/types/device.types.ts
 */

export enum EiOSDevices {
  'ipad-pro-6th-gen' = 'ipad-pro-6th-gen',
  'iphone-14' = 'iphone-14',
  'iphone-14-pro' = 'iphone-14-pro',
  'iphone-15' = 'iphone-15',
  'iphone-15-pro' = 'iphone-15-pro',
  'iphone-16' = 'iphone-16',
  'iphone-16-plus' = 'iphone-16-plus',
  'iphone-16-pro' = 'iphone-16-pro',
  'iphone-16-pro-max' = 'iphone-16-pro-max',
}

export enum EAndroidDevices {
  'generic-tablet' = 'generic-tablet',
  'pixel-6' = 'pixel-6',
  'pixel-6-pro' = 'pixel-6-pro',
  'pixel-7' = 'pixel-7',
  'pixel-7-pro' = 'pixel-7-pro',
}

export enum EiOSVersions {
  'eighteen' = '18',
  'seventeen' = '17',
  'sixteen' = '16',
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
