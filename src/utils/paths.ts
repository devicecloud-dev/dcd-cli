import * as path from 'node:path';

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
