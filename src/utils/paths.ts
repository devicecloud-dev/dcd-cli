import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Expand a leading `~` to the home directory, as the download paths allow. */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/|\\)/, homedir());
}

/** The file name an artifacts download gets when it is given a folder. */
export const DEFAULT_ARTIFACTS_FILENAME = 'artifacts.zip';

/**
 * Where an artifacts download goes. A folder, meaning one that exists or a
 * path ending in a separator, gets `artifacts.zip` inside it. Anything else is
 * a file path and is returned unchanged, so calling this twice is harmless.
 * Writing to a folder path used to fail with EISDIR, after the download had
 * started.
 */
export function resolveArtifactsPath(p: string): string {
  const endsWithSeparator = /[/\\]$/.test(p);
  if (endsWithSeparator || isDirectory(expandHome(p))) {
    return path.join(p, DEFAULT_ARTIFACTS_FILENAME);
  }

  return p;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Convert an absolute path into the portable './'-prefixed, forward-slash
 * relative form used as flow keys across submission, metadata maps, and
 * polling. `commonRoot` must be a whole-segment prefix of `absolutePath`
 * without a trailing separator (or '' when no common root exists, in which
 * case the path is kept whole apart from separator normalization).
 *
 * Replaces the old `replaceAll(commonRoot, '.')` pattern, which corrupted
 * paths when the root substring recurred mid-path or collapsed to ''.
 */
export function toPortableRelativePath(
  absolutePath: string,
  commonRoot: string,
): string {
  let relative = absolutePath;
  if (commonRoot && absolutePath.startsWith(commonRoot)) {
    relative = absolutePath.slice(commonRoot.length);
  }
  if (!relative.startsWith(path.sep)) {
    relative = path.sep + relative;
  }
  return ('.' + relative).split(path.sep).join('/');
}
