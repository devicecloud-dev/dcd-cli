/**
 * `dcd upgrade` — in-place replace of the standalone binary.
 *
 * Only meaningful for the bun-compiled binary install. npm-installed users
 * are redirected to `npm install -g`. Fetches the latest version from the
 * release manifest, downloads the matching binary, verifies its SHA256
 * against the published SHA256SUMS, then atomically renames over the running
 * executable (the old inode stays alive until the process exits).
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { defineCommand } from 'citty';

import { VersionService } from '../services/version.service';
import {
  CliError,
  getCliVersion,
  getInstallMethod,
  logger,
} from '../utils/cli';
import { colors, symbols } from '../utils/styling';

const DEFAULT_DOWNLOAD_BASE = 'https://get.devicecloud.dev';

// Maps `${process.platform}-${process.arch}` to the GitHub Release asset filename
// produced by scripts/build-binaries.mjs. Keys must stay in sync with that script.
const ASSET_BY_PLATFORM: Record<string, string> = {
  'darwin-arm64': 'dcd-darwin-arm64',
  'darwin-x64': 'dcd-darwin-x64',
  'linux-arm64': 'dcd-linux-arm64',
  'linux-x64': 'dcd-linux-x64',
  'win32-x64': 'dcd-windows-x64.exe',
};

export const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Upgrade dcd in place to the latest released version',
  },
  async run() {
    if (getInstallMethod() !== 'binary') {
      throw new CliError(
        '`dcd upgrade` only applies to the standalone binary install. ' +
          'Run: npm install -g @devicecloud.dev/dcd@latest',
      );
    }

    const current = getCliVersion();
    const versionService = new VersionService();
    const latest = await versionService.checkLatestCliVersion();

    if (!latest) {
      throw new CliError(
        'Could not reach the update manifest. Check your network connection and try again.',
      );
    }

    if (!versionService.isOutdated(current, latest)) {
      logger.log(
        `${symbols.success} Already on the latest version (${colors.highlight(current)}).`,
      );
      return;
    }

    const platformKey = `${process.platform}-${process.arch}`;
    const asset = ASSET_BY_PLATFORM[platformKey];
    if (!asset) {
      throw new CliError(
        `No binary published for ${platformKey}. Supported platforms: ${Object.keys(
          ASSET_BY_PLATFORM,
        ).join(', ')}`,
      );
    }

    if (process.platform === 'win32') {
      // Windows can't replace a running .exe; defer to a re-run of the installer.
      const base = process.env.DCD_DOWNLOAD_BASE ?? DEFAULT_DOWNLOAD_BASE;
      throw new CliError(
        `Automatic upgrade on Windows is not yet supported. Re-run the installer:\n  irm ${base}/install.ps1 | iex`,
      );
    }

    const base = process.env.DCD_DOWNLOAD_BASE ?? DEFAULT_DOWNLOAD_BASE;
    const binaryUrl = `${base}/download/${latest}/${asset}`;
    const sumsUrl = `${base}/download/${latest}/SHA256SUMS`;

    logger.log(
      `${symbols.info} Upgrading ${colors.highlight(current)} → ${colors.highlight(latest)}`,
    );
    logger.log(colors.dim(`  ${binaryUrl}`));

    const execPath = process.execPath;
    const tmpPath = `${execPath}.new`;

    try {
      await downloadToFile(binaryUrl, tmpPath);
      const expected = await fetchExpectedChecksum(sumsUrl, asset);
      const actual = await sha256File(tmpPath);
      if (expected !== actual) {
        throw new Error(
          `Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`,
        );
      }
      chmodSync(tmpPath, 0o755);
      // rename is atomic on the same filesystem; on POSIX the running process
      // keeps the old inode open until exit, so this is safe to do mid-run.
      renameSync(tmpPath, execPath);
    } catch (e) {
      safeUnlink(tmpPath);
      throw new CliError(
        `Upgrade failed: ${(e as Error).message}. The existing binary at ${execPath} was not modified.`,
      );
    }

    logger.log(`${symbols.success} Upgraded to ${colors.highlight(latest)}`);
  },
});

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  // Node 22 exposes Readable.fromWeb for piping a WHATWG ReadableStream.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function fetchExpectedChecksum(
  sumsUrl: string,
  asset: string,
): Promise<string> {
  const res = await fetch(sumsUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${sumsUrl}`);
  const body = await res.text();
  for (const line of body.split('\n')) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match && match[2].trim() === asset) return match[1];
  }
  throw new Error(`SHA256SUMS has no entry for ${asset}`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup; failure here would only leave a .new file.
  }
}

export default upgradeCommand;
