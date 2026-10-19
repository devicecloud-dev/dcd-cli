import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { DeviceGateway } from '../gateways/device-gateway.js';
import type { AuthContext } from '../types/domain/auth.types.js';
import type {
  DeviceArtifactLink,
  DeviceArtifactsPage,
  DeviceSession,
} from '../types/domain/device-session.types.js';

/** One file a session left behind, and where it goes on disk. */
export interface DeviceArtifactFile {
  /** recording, logs, screenshot or hierarchy. */
  kind: 'hierarchy' | 'logs' | 'recording' | 'screenshot';
  /** Relative to the output directory. */
  file: string;
  url: null | string;
  bytes: null | number;
  /** The action a screenshot or screen dump was taken after. */
  command_id?: null | string;
  created_at: string;
}

const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'text/plain': 'log',
  'video/mp4': 'mp4',
};

function extensionFor(link: DeviceArtifactLink, fallback: string): string {
  return EXTENSIONS[link.content_type.split(';')[0].trim()] ?? fallback;
}

/** Every page of a session's artifacts. */
export async function fetchAllArtifacts(
  apiUrl: string,
  auth: AuthContext,
  id: string,
): Promise<{ pages: DeviceArtifactsPage[]; session: DeviceSession }> {
  const pages: DeviceArtifactsPage[] = [];
  let before: string | undefined;
  do {
    const page = await DeviceGateway.artifacts(apiUrl, auth, id, before);
    pages.push(page);
    before = page.next_before ?? undefined;
  } while (before);
  return { pages, session: pages.at(-1)!.session };
}

/**
 * Lay the artifacts out as files: `recording.mp4`, `device.log`, and per
 * action `actions/001-screenshot.jpg` and `actions/001-screen.json`,
 * numbered oldest first so the folder reads in order.
 */
export function planArtifactFiles(pages: DeviceArtifactsPage[]): DeviceArtifactFile[] {
  const files: DeviceArtifactFile[] = [];
  const first = pages[0];
  if (first?.recording) {
    files.push({
      kind: 'recording',
      file: `recording.${extensionFor(first.recording, 'mp4')}`,
      url: first.recording.url,
      bytes: first.recording.bytes,
      created_at: first.recording.created_at,
    });
  }

  if (first?.logs) {
    files.push({
      kind: 'logs',
      file: `device.${extensionFor(first.logs, 'log')}`,
      url: first.logs.url,
      bytes: first.logs.bytes,
      created_at: first.logs.created_at,
    });
  }

  const actions = pages.flatMap((p) => p.actions).reverse();
  const width = Math.max(3, String(actions.length).length);
  for (const [i, action] of actions.entries()) {
    const n = String(i + 1).padStart(width, '0');
    if (action.screenshot) {
      files.push({
        kind: 'screenshot',
        file: path.join('actions', `${n}-screenshot.${extensionFor(action.screenshot, 'jpg')}`),
        url: action.screenshot.url,
        bytes: action.screenshot.bytes,
        command_id: action.command_id,
        created_at: action.created_at,
      });
    }

    if (action.hierarchy) {
      files.push({
        kind: 'hierarchy',
        file: path.join('actions', `${n}-screen.${extensionFor(action.hierarchy, 'json')}`),
        url: action.hierarchy.url,
        bytes: action.hierarchy.bytes,
        command_id: action.command_id,
        created_at: action.created_at,
      });
    }
  }

  return files;
}

const CONCURRENCY = 4;

/**
 * Download every file with a link into `dir`, four at a time. Returns the
 * files that could not be fetched, with why, rather than failing the rest.
 */
export async function downloadArtifactFiles(
  dir: string,
  files: DeviceArtifactFile[],
  onFile: (file: DeviceArtifactFile) => void = () => {},
): Promise<{ file: string; reason: string }[]> {
  const failed: { file: string; reason: string }[] = [];
  const queue = [...files];
  async function worker(): Promise<void> {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (!next.url) {
        failed.push({ file: next.file, reason: 'no download link (it may have been cleaned up)' });
        continue;
      }

      const target = path.join(dir, next.file);
      try {
        await mkdir(path.dirname(target), { recursive: true });
        const res = await fetch(next.url);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        await pipeline(
          Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
          createWriteStream(target),
        );
        onFile(next);
      } catch (error) {
        failed.push({ file: next.file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return failed;
}
