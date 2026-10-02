import { expect } from 'chai';

import { readManifestPackage } from '../../src/utils/android-manifest.js';

/**
 * Real APKs (test/fixtures/wikipedia.apk and every other APK checked against
 * aapt2) compile their manifest with a UTF-16 string pool, so these build
 * minimal binary manifests by hand to cover the UTF-8 pool and the edge cases.
 */
const NO_INDEX = 0xff_ff_ff_ff;

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32s(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  for (const [i, value] of values.entries()) buffer.writeUInt32LE(value, i * 4);
  return buffer;
}

/** A ResChunk_header plus `header` (the rest of the chunk's header) and `body`. */
function chunk(type: number, header: Buffer, body: Buffer): Buffer {
  const headerSize = 8 + header.length;
  return Buffer.concat([
    u16(type),
    u16(headerSize),
    u32s(headerSize + body.length),
    header,
    body,
  ]);
}

function utf8Length(length: number): Buffer {
  return Buffer.from(
    length > 0x7f ? [(length >> 8) | 0x80, length & 0xff] : [length],
  );
}

function stringPool(strings: string[], utf8: boolean): Buffer {
  const encoded = strings.map((value) => {
    if (utf8) {
      const bytes = Buffer.from(value, 'utf8');
      return Buffer.concat([
        utf8Length(value.length),
        utf8Length(bytes.length),
        bytes,
        Buffer.from([0]),
      ]);
    }
    return Buffer.concat([
      u16(value.length),
      Buffer.from(value, 'utf16le'),
      u16(0),
    ]);
  });

  const offsets: number[] = [];
  let next = 0;
  for (const entry of encoded) {
    offsets.push(next);
    next += entry.length;
  }
  const data = Buffer.concat(encoded);
  const padded = Buffer.concat([
    data,
    Buffer.alloc((4 - (data.length % 4)) % 4),
  ]);

  const stringsStart = 28 + strings.length * 4;
  const header = u32s(strings.length, 0, utf8 ? 0x01_00 : 0, stringsStart, 0);
  return chunk(0x00_01, header, Buffer.concat([u32s(...offsets), padded]));
}

/**
 * A binary AndroidManifest.xml whose root is `<tag>` with string-typed
 * `attributes`.
 */
function manifest(
  attributes: Record<string, string>,
  { tag = 'manifest', utf8 = false } = {},
): Buffer {
  const strings = [tag];
  const index = (value: string): number => {
    if (!strings.includes(value)) strings.push(value);
    return strings.indexOf(value);
  };

  const tagIndex = index(tag);
  const attrs = Object.entries(attributes).map(([name, value]) => {
    const valueIndex = index(value);
    return Buffer.concat([
      u32s(NO_INDEX, index(name), valueIndex),
      u16(8),
      Buffer.from([0, 0x03]), // res0, TYPE_STRING
      u32s(valueIndex),
    ]);
  });
  const ext = Buffer.concat([
    u32s(NO_INDEX, tagIndex),
    u16(20), // attributeStart
    u16(20), // attributeSize
    u16(attrs.length),
    u16(0),
    u16(0),
    u16(0),
  ]);
  const startElement = chunk(
    0x01_02,
    u32s(1, NO_INDEX), // lineNumber, comment
    Buffer.concat([ext, ...attrs]),
  );
  // Android's own parser rejects a document that ends on the start element.
  const endElement = chunk(
    0x01_03,
    u32s(1, NO_INDEX),
    u32s(NO_INDEX, tagIndex),
  );

  return chunk(
    0x00_03,
    Buffer.alloc(0),
    Buffer.concat([stringPool(strings, utf8), startElement, endElement]),
  );
}

describe('readManifestPackage', () => {
  it('reads the package from a UTF-16 string pool', () => {
    expect(
      readManifestPackage(manifest({ package: 'com.example.app' })),
    ).to.equal('com.example.app');
  });

  it('reads the package from a UTF-8 string pool', () => {
    const xml = manifest({ package: 'com.example.app' }, { utf8: true });
    expect(readManifestPackage(xml)).to.equal('com.example.app');
  });

  it('reads UTF-8 strings longer than 127 bytes (two-byte lengths)', () => {
    const id = `com.example.${'a'.repeat(140)}`;
    expect(
      readManifestPackage(manifest({ package: id }, { utf8: true })),
    ).to.equal(id);
  });

  it('finds the package among other attributes', () => {
    const xml = manifest({
      versionCode: '42',
      package: 'com.example.app',
      versionName: '1.0',
    });
    expect(readManifestPackage(xml)).to.equal('com.example.app');
  });

  it('throws when the root element has no package attribute', () => {
    expect(() =>
      readManifestPackage(manifest({ versionName: '1.0' })),
    ).to.throw('no package attribute');
  });

  it('throws when the root element is not <manifest>', () => {
    const xml = manifest(
      { package: 'com.example.app' },
      { tag: 'application' },
    );
    expect(() => readManifestPackage(xml)).to.throw('not <manifest>');
  });

  it('throws on a plain-text manifest', () => {
    const xml = Buffer.from('<manifest package="com.example.app" />');
    expect(() => readManifestPackage(xml)).to.throw('not Android binary XML');
  });

  it('throws on a truncated manifest', () => {
    const xml = manifest({ package: 'com.example.app' });
    expect(() => readManifestPackage(xml.subarray(0, 40))).to.throw();
  });

  it('throws on a zero-size chunk instead of looping forever', () => {
    const xml = manifest({ package: 'com.example.app' });
    xml.writeUInt32LE(0, 12); // the string pool chunk's size
    expect(() => readManifestPackage(xml)).to.throw('Malformed');
  });
});
