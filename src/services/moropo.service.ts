import { ux } from '../utils/progress';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import StreamZip = require('node-stream-zip');

export interface MoropoDownloadOptions {
  apiKey: string;
  branchName?: string;
  debug?: boolean;
  json?: boolean;
  logger?: (message: string) => void;
  quiet?: boolean;
}

/**
 * Service for downloading and extracting Moropo tests from the Moropo API
 */
export class MoropoService {
  private readonly MOROPO_API_URL = 'https://api.moropo.com/tests';

  /**
   * Download and extract Moropo tests from the API
   * @param options Download configuration options
   * @returns Path to the extracted Moropo tests directory
   */
  public async downloadAndExtract(
    options: MoropoDownloadOptions,
  ): Promise<string> {
    const { apiKey, branchName = 'main', debug = false, quiet = false, json = false, logger } = options;

    this.logDebug(debug, logger, '[DEBUG] Moropo v1 API key detected, downloading tests from Moropo API');
    this.logDebug(debug, logger, `[DEBUG] Using branch name: ${branchName}`);

    try {
      if (!quiet && !json) {
        ux.action.start('Downloading Moropo tests', 'Initializing', {
          stdout: true,
        });
      }

      const response = await fetch(this.MOROPO_API_URL, {
        headers: {
          accept: 'application/zip',
          'x-app-api-key': apiKey,
          'x-branch-name': branchName,
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to download Moropo tests: ${response.statusText}`,
        );
      }

      const moropoDir = path.join(
        os.tmpdir(),
        `moropo-tests-${Date.now()}`,
      );

      this.logDebug(debug, logger, `[DEBUG] Extracting Moropo tests to: ${moropoDir}`);

      // Create moropo directory if it doesn't exist
      if (!fs.existsSync(moropoDir)) {
        fs.mkdirSync(moropoDir, { recursive: true });
      }

      // Download zip file
      const zipPath = path.join(moropoDir, 'moropo-tests.zip');
      await this.downloadZipFile(response, zipPath, { quiet, json });

      this.showProgress(quiet, json, 'Extracting tests...');

      // Extract zip file
      await this.extractZipFile(zipPath, moropoDir);

      if (!quiet && !json) {
        ux.action.stop('completed');
      }

      this.logDebug(debug, logger, '[DEBUG] Successfully extracted Moropo tests');

      // Create config.yaml file
      this.createConfigFile(moropoDir);
      this.logDebug(debug, logger, '[DEBUG] Created config.yaml file');

      return moropoDir;
    } catch (error) {
      if (!quiet && !json) {
        ux.action.stop('failed');
      }

      this.logDebug(debug, logger, `[DEBUG] Error downloading/extracting Moropo tests: ${error}`);
      throw new Error(`Failed to download/extract Moropo tests: ${error}`);
    }
  }

  private createConfigFile(moropoDir: string): void {
    const configPath = path.join(moropoDir, 'config.yaml');
    fs.writeFileSync(configPath, 'flows:\n- ./**/*.yaml\n- ./*.yaml\n');
  }

  private async downloadZipFile(
    response: Response,
    zipPath: string,
    options: { json: boolean; quiet: boolean },
  ): Promise<void> {
    const { quiet, json } = options;
    const contentLength = response.headers.get('content-length');
    const totalSize = contentLength ? Number.parseInt(contentLength, 10) : 0;
    let downloadedSize = 0;

    const fileStream = fs.createWriteStream(zipPath);
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('Failed to get response reader');
    }

    let readerResult = await reader.read();
    while (!readerResult.done) {
      const { value } = readerResult;
      downloadedSize += value.length;

      if (!quiet && !json && totalSize) {
        const progress = Math.round((downloadedSize / totalSize) * 100);
        ux.action.status = `Downloading: ${progress}%`;
      }

      fileStream.write(value);
      readerResult = await reader.read();
    }

    fileStream.end();
    await new Promise<void>((resolve) => {
      fileStream.on('finish', () => {
        resolve();
      });
    });
  }

  private async extractZipFile(zipPath: string, extractPath: string): Promise<void> {
    // eslint-disable-next-line new-cap
    const zip = new StreamZip.async({ file: zipPath });
    await zip.extract(null, extractPath);
    await zip.close();
    fs.unlinkSync(zipPath);
  }

  private logDebug(debug: boolean, logger: ((message: string) => void) | undefined, message: string): void {
    if (debug && logger) {
      logger(message);
    }
  }

  private showProgress(quiet: boolean, json: boolean, message: string): void {
    if (!quiet && !json) {
      ux.action.status = message;
    }
  }
}
