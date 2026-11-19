import * as yazl from 'yazl';

/**
 * A stored (uncompressed) ZIP holding `count` entries of `size` bytes, each
 * filled with `fill + i` so two fixtures with different fills differ.
 */
export async function zipBuffer(count = 20, size = 4096, fill = 0): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (let i = 0; i < count; i++) {
    zip.addBuffer(Buffer.alloc(size, (fill + i) % 256), `${i}/logs/file-${i}.log`, {
      compress: false,
    });
  }

  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
