import { expect } from 'chai';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tus from 'tus-js-client';

import { FetchHttpStack, tusHttpStackOptions } from '../../src/gateways/fetch-http-stack.js';

/**
 * The standalone binary runs on Bun, whose node:http can't send tus's
 * upload-creating POST, so it uploads through FetchHttpStack instead.
 */
describe('FetchHttpStack', () => {
  let server: Server;
  let endpoint: string;
  let dir: string;
  let received: Buffer;
  let requests: string[];

  const readAll = async (req: IncomingMessage): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    return Buffer.concat(parts);
  };

  // A minimal tus server: POST creates (with data), PATCH appends.
  beforeEach(async () => {
    received = Buffer.alloc(0);
    requests = [];
    dir = mkdtempSync(join(tmpdir(), 'dcd-tus-'));
    server = createServer(async (req, res) => {
      const body = await readAll(req);
      requests.push(`${req.method} ${body.length} ${req.headers['x-upsert'] ?? ''}`);
      received = Buffer.concat([received, body]);
      const headers = { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(received.length) };
      if (req.method === 'POST') {
        res.writeHead(201, { ...headers, Location: `${endpoint}/upload-1` });
      } else {
        res.writeHead(204, headers);
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/files`;
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    // fetch keeps its connections alive, which would hold close() open.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('uploads a file stream in chunks, data on create', async () => {
    const file = join(dir, 'app.bin');
    const content = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
    writeFileSync(file, content);
    const progress: number[] = [];

    await new Promise<void>((resolve, reject) => {
      new tus.Upload(createReadStream(file), {
        endpoint,
        uploadSize: content.length,
        chunkSize: 1000,
        uploadDataDuringCreation: true,
        retryDelays: [],
        headers: { 'x-upsert': 'true' },
        httpStack: new FetchHttpStack(),
        onProgress: (sent) => progress.push(sent),
        onError: reject,
        onSuccess: () => resolve(),
      }).start();
    });

    expect(received.equals(content)).to.equal(true);
    expect(requests).to.deep.equal(['POST 1000 true', 'PATCH 1000 true', 'PATCH 500 true']);
    expect(progress.at(-1)).to.equal(content.length);
  });

  it('turns a server error into a tus error', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(403, { 'Tus-Resumable': '1.0.0' });
      res.end('denied');
    });

    const error = await new Promise<Error>((resolve, reject) => {
      new tus.Upload(Buffer.from('abc'), {
        endpoint,
        retryDelays: [],
        httpStack: new FetchHttpStack(),
        onError: resolve,
        onSuccess: () => reject(new Error('expected the upload to fail')),
      }).start();
    });

    expect(error.message).to.contain('response code: 403');
    expect(error.message).to.contain('denied');
  });

  it('is used under Bun only, and leaves no httpStack key under Node', () => {
    expect(tusHttpStackOptions(true).httpStack).to.be.instanceOf(FetchHttpStack);
    // An explicit `httpStack: undefined` would replace tus's default stack.
    expect(tusHttpStackOptions(false)).to.deep.equal({});
  });
});
