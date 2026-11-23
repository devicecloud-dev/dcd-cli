import { stat } from 'node:fs/promises';
import StreamZip from 'node-stream-zip';

/**
 * A downloaded ZIP that ends before its central directory, so `unzip` and most
 * tools reject it. A server streams a ZIP's entries first and its central
 * directory last, so a response that stops early, but still closes cleanly,
 * leaves exactly this behind.
 */
export class IncompleteZipError extends Error {
  constructor(
    readonly bytes: number,
    readonly detail?: string,
  ) {
    super(`the ZIP is incomplete (${bytes} bytes, no valid central directory)`);
    this.name = 'IncompleteZipError';
  }
}

/**
 * Check that the file at `filePath` is a complete ZIP: its end-of-central-
 * directory record (or the ZIP64 one) is there and every central directory
 * header after it is intact. Only the central directory is read, never the
 * entries' data, so this costs about its size even for a multi-GB archive.
 *
 * Throws {@link IncompleteZipError} when the file is not a complete ZIP,
 * including when it is empty or missing.
 */
export async function assertCompleteZip(filePath: string): Promise<void> {
  const bytes = await stat(filePath).then(
    (s) => s.size,
    () => 0,
  );
  const zip = new StreamZip.async({
    file: filePath,
    skipEntryNameValidation: true,
    storeEntries: false,
  });
  try {
    // Resolves only once every central directory header has been read.
    await zip.entriesCount;
  } catch (error) {
    throw new IncompleteZipError(
      bytes,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await zip.close().catch(() => {});
  }
}
