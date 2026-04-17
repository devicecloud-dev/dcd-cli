declare module 'app-info-parser' {
  interface AppInfo {
    [key: string]: unknown;
    build?: string;
    icon?: string;
    identifier?: string;
    name?: string;
    platform: 'android' | 'ios';
    version?: string;
  }

  // eslint-disable-next-line unicorn/no-static-only-class
  export default class AppInfoParser {
    static parse(filePath: string): Promise<AppInfo>;
  }
}