import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  assertCompleteZip,
  IncompleteZipError,
} from '../../src/utils/zip-integrity.js';
import { zipBuffer } from '../helpers/zip-fixture.js';

describe('assertCompleteZip', () => {
  let dir: string;
  let complete: Buffer;

  before(async () => {
    complete = await zipBuffer();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-zip-integrity-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  const write = (name: string, data: Buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return file;
  };

  const rejection = async (file: string) => {
    try {
      await assertCompleteZip(file);
    } catch (error) {
      return error;
    }

    throw new Error(`expected ${file} to be rejected`);
  };

  it('accepts a complete ZIP', async () => {
    await assertCompleteZip(write('ok.zip', complete));
  });

  it('accepts an empty ZIP (no entries, just the end record)', async () => {
    await assertCompleteZip(write('none.zip', await zipBuffer(0)));
  });

  for (const [name, cut] of [
    ['cut off among the entries', (b: Buffer) => b.subarray(0, b.length / 2)],
    ['cut off inside the central directory', (b: Buffer) => b.subarray(0, b.length - 40)],
    ['missing only its last byte', (b: Buffer) => b.subarray(0, b.length - 1)],
  ] as const) {
    it(`rejects a ZIP ${name}`, async () => {
      const truncated = cut(complete);
      const error = await rejection(write('cut.zip', truncated));
      expect(error).to.be.instanceOf(IncompleteZipError);
      expect((error as IncompleteZipError).bytes).to.equal(truncated.length);
      expect((error as Error).message).to.include(`${truncated.length} bytes`);
    });
  }

  it('rejects an empty file', async () => {
    const error = await rejection(write('empty.zip', Buffer.alloc(0)));
    expect(error).to.be.instanceOf(IncompleteZipError);
    expect((error as IncompleteZipError).bytes).to.equal(0);
  });

  it('rejects a file that is not a ZIP at all', async () => {
    const error = await rejection(write('page.zip', Buffer.from('<html>Bad gateway</html>')));
    expect(error).to.be.instanceOf(IncompleteZipError);
  });

  it('rejects a missing file', async () => {
    const error = await rejection(path.join(dir, 'missing.zip'));
    expect(error).to.be.instanceOf(IncompleteZipError);
  });
});
