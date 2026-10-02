// Reads the package name out of an APK's compiled AndroidManifest.xml (Android
// binary XML). This replaced node-apk, whose node-forge dependency carried an
// unpatched advisory for certificate code the CLI never used. Layouts follow
// the ResChunk_header / ResStringPool_header / ResXMLTree_* structs in AOSP's
// libandroidfw ResourceTypes.h; every integer is little-endian.

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const UTF8_FLAG = 0x0100;
const TYPE_STRING = 0x03;
const NO_INDEX = 0xffff_ffff;
const CHUNK_HEADER_SIZE = 8;

/**
 * Returns a lookup for the strings in the string pool chunk at `offset`.
 * Strings are decoded on demand, so a malformed entry the manifest never
 * refers to can't fail the parse.
 */
function stringPool(xml: Buffer, offset: number): (index: number) => string {
  const headerSize = xml.readUInt16LE(offset + 2);
  const count = xml.readUInt32LE(offset + 8);
  const utf8 = (xml.readUInt32LE(offset + 16) & UTF8_FLAG) !== 0;
  const stringsStart = offset + xml.readUInt32LE(offset + 20);

  return (index) => {
    if (index >= count) {
      throw new Error(`String index ${index} is out of range`);
    }
    let pos = stringsStart + xml.readUInt32LE(offset + headerSize + index * 4);

    if (utf8) {
      // Two lengths, each 1 byte or 2 when the high bit is set: the UTF-16
      // length (unused here), then the UTF-8 byte length.
      pos += xml[pos] & 0x80 ? 2 : 1;
      let length = xml[pos++];
      if (length & 0x80) length = ((length & 0x7f) << 8) | xml[pos++];
      return xml.toString('utf8', pos, pos + length);
    }

    // UTF-16 length in code units: 2 bytes, or 4 when the high bit is set.
    let length = xml.readUInt16LE(pos);
    pos += 2;
    if (length & 0x80_00) {
      length = ((length & 0x7f_ff) << 16) | xml.readUInt16LE(pos);
      pos += 2;
    }
    return xml.toString('utf16le', pos, pos + length * 2);
  };
}

/**
 * Reads the `package` attribute of the root `<manifest>` element.
 * @param xml - Contents of the APK's AndroidManifest.xml entry
 * @returns The application id, e.g. `org.wikipedia`
 */
export function readManifestPackage(xml: Buffer): string {
  if (xml.length < CHUNK_HEADER_SIZE || xml.readUInt16LE(0) !== RES_XML_TYPE) {
    throw new Error('AndroidManifest.xml is not Android binary XML');
  }

  const end = Math.min(xml.length, xml.readUInt32LE(4));
  let offset = xml.readUInt16LE(2);
  let stringAt: ((index: number) => string) | undefined;

  while (offset + CHUNK_HEADER_SIZE <= end) {
    const type = xml.readUInt16LE(offset);
    const headerSize = xml.readUInt16LE(offset + 2);
    const size = xml.readUInt32LE(offset + 4);
    if (size < CHUNK_HEADER_SIZE) {
      throw new Error(`Malformed binary XML chunk at offset ${offset}`);
    }

    if (type === RES_STRING_POOL_TYPE) {
      stringAt = stringPool(xml, offset);
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      // The first element is the document root.
      if (!stringAt) throw new Error('Binary XML has no string pool');
      const ext = offset + headerSize;
      if (stringAt(xml.readUInt32LE(ext + 4)) !== 'manifest') {
        throw new Error(
          'Root element of AndroidManifest.xml is not <manifest>',
        );
      }

      const attributeStart = ext + xml.readUInt16LE(ext + 8);
      const attributeSize = xml.readUInt16LE(ext + 10);
      const attributeCount = xml.readUInt16LE(ext + 12);
      for (let i = 0; i < attributeCount; i++) {
        const attr = attributeStart + i * attributeSize;
        if (stringAt(xml.readUInt32LE(attr + 4)) !== 'package') continue;

        // Use the typed string value when there is one, else the raw string
        // the attribute was compiled from.
        const raw = xml.readUInt32LE(attr + 8);
        const index =
          xml[attr + 15] === TYPE_STRING ? xml.readUInt32LE(attr + 16) : raw;
        if (index === NO_INDEX) break;
        return stringAt(index);
      }

      throw new Error('<manifest> has no package attribute');
    }

    offset += size;
  }

  throw new Error('AndroidManifest.xml has no <manifest> element');
}
