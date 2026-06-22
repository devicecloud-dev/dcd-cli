import { parseBuffer } from 'bplist-parser';
import { Apk } from 'node-apk';
import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import StreamZip from 'node-stream-zip';
import { parse } from 'plist';

export interface TAppMetadata {
  appId: string;
  platform: 'android' | 'ios';
}

/**
 * Interface for platform-specific metadata extractors
 */
export interface IMetadataExtractor {
  canHandle(filePath: string): boolean;
  extract(filePath: string): Promise<TAppMetadata>;
}

/**
 * Parses an Info.plist buffer (XML, UTF-8 BOM'd XML, or binary bplist).
 * Shared by the .app and .zip extractors.
 */
function parseInfoPlist(buffer: Buffer): { CFBundleIdentifier: string } {
  let data;
  const bufferType = buffer[0];
  // 60 = '<' (XML plist), 239 = UTF-8 BOM, 98 = 'b' (binary "bplist")
  if (bufferType === 60 || bufferType === 239) {
    data = parse(buffer.toString());
  } else if (bufferType === 98) {
    data = parseBuffer(buffer)[0];
  } else {
    throw new Error('Unknown plist buffer type.');
  }

  return data;
}

/**
 * Extracts metadata from Android APK files
 */
export class AndroidMetadataExtractor implements IMetadataExtractor {
  canHandle(filePath: string): boolean {
    return filePath.endsWith('.apk');
  }

  async extract(filePath: string): Promise<TAppMetadata> {
    const apk = new Apk(filePath);
    try {
      const manifest = await apk.getManifestInfo();
      return { appId: manifest.package, platform: 'android' };
    } finally {
      apk.close();
    }
  }
}

/**
 * Extracts metadata from iOS .app directories
 */
export class IosAppMetadataExtractor implements IMetadataExtractor {
  canHandle(filePath: string): boolean {
    return filePath.endsWith('.app');
  }

  async extract(filePath: string): Promise<TAppMetadata> {
    const infoPlistPath = path.normalize(path.join(filePath, 'Info.plist'));
    const buffer = await readFile(infoPlistPath);
    const data = parseInfoPlist(buffer);
    const appId = data.CFBundleIdentifier;
    return { appId, platform: 'ios' };
  }
}

/**
 * Extracts metadata from iOS .zip files containing .app bundles
 */
export class IosZipMetadataExtractor implements IMetadataExtractor {
  canHandle(filePath: string): boolean {
    return filePath.endsWith('.zip');
  }

  async extract(filePath: string): Promise<TAppMetadata> {
    return new Promise<TAppMetadata>((resolve, reject) => {
      const zip = new StreamZip({ file: filePath });

      // A throw inside an emitter callback escapes the caller's try/catch and
      // crashes the process, so route all failures through reject explicitly.
      zip.on('ready', () => {
        try {
          // Get all entries and sort them by path depth
          const entries = Object.values(zip.entries());
          const sortedEntries = entries.sort((a, b) => {
            const aDepth = a.name.split('/').length;
            const bDepth = b.name.split('/').length;
            return aDepth - bDepth;
          });

          // Find the first Info.plist in the shallowest directory
          const infoPlist = sortedEntries.find((e) =>
            e.name.endsWith('.app/Info.plist'),
          );

          if (!infoPlist) {
            reject(new Error('Failed to find info plist'));
            return;
          }

          const buffer = zip.entryDataSync(infoPlist.name);
          const data = parseInfoPlist(buffer);
          resolve({ appId: data.CFBundleIdentifier, platform: 'ios' });
        } catch (error) {
          reject(error);
        } finally {
          zip.close();
        }
      });

      zip.on('error', (error) => {
        zip.close();
        reject(error);
      });
    });
  }
}

/**
 * Extracts metadata from Expo iOS .tar.gz archives by extracting the
 * archive to a temp directory, finding the .app bundle inside, then
 * delegating to IosAppMetadataExtractor.
 */
export class ExpoTarGzMetadataExtractor implements IMetadataExtractor {
  canHandle(filePath: string): boolean {
    return filePath.endsWith('.tar.gz');
  }

  async extract(filePath: string): Promise<TAppMetadata> {
    const { extractTarGz, findAppBundle } = await import('../utils/expo.js');
    const extractDir = await extractTarGz(filePath, false);
    try {
      const appPath = await findAppBundle(extractDir);
      const iosExtractor = new IosAppMetadataExtractor();
      return await iosExtractor.extract(appPath);
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Service for extracting app metadata from various file formats
 */
export class MetadataExtractorService {
  private extractors: IMetadataExtractor[] = [
    new AndroidMetadataExtractor(),
    new ExpoTarGzMetadataExtractor(),
    new IosZipMetadataExtractor(),
    new IosAppMetadataExtractor(),
  ];

  /**
   * Extract app metadata from a file
   * @param filePath - Path to the app file (.apk, .app, or .zip)
   * @returns App metadata or undefined if extraction fails
   */
  async extract(filePath: string): Promise<TAppMetadata | undefined> {
    const extractor = this.extractors.find((e) => e.canHandle(filePath));
    if (!extractor) {
      return undefined;
    }

    try {
      return await extractor.extract(filePath);
    } catch {
      console.warn(
        'Failed to extract app metadata, please share with support@devicecloud.dev so we can improve our parsing.',
      );
      return undefined;
    }
  }
}
