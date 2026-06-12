import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AndroidMetadataExtractor,
  MetadataExtractorService,
} from '../../src/services/metadata-extractor.service';

const WIKIPEDIA_APK = path.resolve('test/fixtures/wikipedia.apk');

describe('AndroidMetadataExtractor', () => {
  const extractor = new AndroidMetadataExtractor();

  it('reports it can handle .apk files', () => {
    expect(extractor.canHandle('/tmp/app.apk')).to.equal(true);
    expect(extractor.canHandle('/tmp/app.zip')).to.equal(false);
    expect(extractor.canHandle('/tmp/app.ipa')).to.equal(false);
  });

  it('extracts the package id from a real APK', async () => {
    const result = await extractor.extract(WIKIPEDIA_APK);
    expect(result).to.deep.equal({
      appId: 'org.wikipedia',
      platform: 'android',
    });
  });

  it('rejects when given a file that is not a valid APK', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-apk-test-'));
    const fakeApk = path.join(tempDir, 'not-really.apk');
    fs.writeFileSync(fakeApk, 'definitely not an apk');

    let threw = false;
    try {
      await extractor.extract(fakeApk);
    } catch (error) {
      threw = true;
      expect(error).to.be.instanceOf(Error);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    expect(threw, 'expected extract() to throw on invalid APK').to.equal(true);
  });
});

describe('MetadataExtractorService (APK path)', () => {
  const service = new MetadataExtractorService();

  it('returns android metadata for a real APK', async () => {
    const result = await service.extract(WIKIPEDIA_APK);
    expect(result).to.deep.equal({
      appId: 'org.wikipedia',
      platform: 'android',
    });
  });

  it('returns undefined for an unsupported file extension', async () => {
    const result = await service.extract('/tmp/something.unknown');
    expect(result).to.equal(undefined);
  });

  it('returns undefined (and does not throw) when extraction fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-apk-test-'));
    const fakeApk = path.join(tempDir, 'broken.apk');
    fs.writeFileSync(fakeApk, 'definitely not an apk');

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await service.extract(fakeApk);
      expect(result).to.equal(undefined);
    } finally {
      console.warn = originalWarn;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
