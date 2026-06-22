/**
 * Pure helpers for turning absolute flow paths into the server-side relative
 * keys that submission, the polling layer, and JSON output all share.
 *
 * Extracted from the cloud command so the MCP `dcd_run_cloud_test` tool builds
 * byte-identical paths without duplicating the logic.
 */
import * as path from 'node:path';

import { toPortableRelativePath } from '../utils/paths';

/**
 * Longest whole-segment directory prefix shared by every flow + referenced
 * file path. Segment comparison (not `startsWith`) so sibling dirs like
 * `flows`/`flows-extra` can't merge, and the file segment itself is never
 * consumed. Returns '' when the paths share no root at all (or none are given).
 */
export function computeCommonRoot(
  testFileNames: string[],
  referencedFiles: string[],
): string {
  const pathsShortestToLongest = [...testFileNames, ...referencedFiles].sort(
    (a, b) => a.split(path.sep).length - b.split(path.sep).length,
  );
  if (pathsShortestToLongest.length === 0) return '';

  const splitPaths = pathsShortestToLongest.map((p) => p.split(path.sep));
  const shortestSegments = splitPaths[0];
  let matchedSegments = 0;
  for (let i = 0; i < shortestSegments.length - 1; i++) {
    if (splitPaths.every((segments) => segments[i] === shortestSegments[i])) {
      matchedSegments = i + 1;
    } else {
      break;
    }
  }
  return shortestSegments.slice(0, matchedSegments).join(path.sep);
}

export interface FlowMetadataEntry {
  flowName: string;
  tags: string[];
}

/**
 * Build the portable-relative-path → {flowName, tags} map that results are
 * keyed by. Flow name comes from the YAML `name` field, falling back to the
 * filename without extension; tags are normalized to a string array.
 */
export function buildTestMetadataMap(
  flowMetadata: Record<string, Record<string, unknown> | null>,
  commonRoot: string,
): Record<string, FlowMetadataEntry> {
  const map: Record<string, FlowMetadataEntry> = {};
  for (const [absolutePath, meta] of Object.entries(flowMetadata)) {
    const normalizedPath = toPortableRelativePath(absolutePath, commonRoot);
    const flowName = (meta?.name as string) || path.parse(absolutePath).name;
    const rawTags = meta?.tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.map(String)
      : rawTags
        ? [String(rawTags)]
        : [];
    map[normalizedPath] = { flowName, tags };
  }
  return map;
}
