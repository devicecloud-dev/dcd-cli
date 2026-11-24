import { expect } from 'chai';
import * as fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { resetCliConfigCache } from '../../src/config/cli-config.js';
import { ApiGateway } from '../../src/gateways/api-gateway.js';
import {
  isSignatureError,
  type SignedUpload,
  SupabaseGateway,
} from '../../src/gateways/supabase-gateway.js';
import { uploadSupabaseCopy } from '../../src/methods.js';

/**
 * Uploads straight to the final storage path with a signed token. Storage
 * checks the token on every TUS request, so the client has to send it as
 * `x-signature` each time, and get a fresh one when it is refused or about
 * to expire.
 */

interface SeenRequest {
  method: string;
  objectName?: string;
  signature?: string;
  upsert?: string;
  url: string;
}

/** Decode tus's `Upload-Metadata` header (`key base64,key base64`). */
function objectNameOf(header: string | undefined): string | undefined {
  for (const pair of (header ?? '').split(',')) {
    const [key, value] = pair.trim().split(' ');
    if (key === 'objectName' && value) return Buffer.from(value, 'base64').toString();
  }

  return undefined;
}

/**
 * A minimal TUS server: creation with data in one request, which is all a
 * file smaller than one chunk needs. `refuse` decides, per request, whether
 * to answer like Storage does for a bad signature.
 */
function startTusServer(refuse: (signature: string | undefined, n: number) => boolean): Promise<{
  seen: SeenRequest[];
  server: Server;
  url: string;
}> {
  const seen: SeenRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const signature = req.headers['x-signature'] as string | undefined;
      seen.push({
        method: req.method ?? '',
        objectName: objectNameOf(req.headers['upload-metadata'] as string | undefined),
        signature,
        upsert: req.headers['x-upsert'] as string | undefined,
        url: req.url ?? '',
      });

      res.setHeader('Tus-Resumable', '1.0.0');
      if (refuse(signature, seen.length)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'InvalidJWT', message: 'jwt expired', statusCode: '400' }));
        return;
      }

      const received = Buffer.concat(chunks).length;
      res.writeHead(201, {
        Location: `${req.url}/upload-1`,
        'Upload-Offset': String(received),
      });
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ seen, server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('isSignatureError', () => {
  it('spots a refused token', () => {
    expect(isSignatureError(400, '{"error":"InvalidJWT","message":"jwt expired"}')).to.equal(true);
    expect(isSignatureError(403, 'invalid signature')).to.equal(true);
  });

  it('spots the messages Storage actually sends', () => {
    expect(isSignatureError(400, '"exp" claim timestamp check failed')).to.equal(true);
    expect(isSignatureError(400, 'The provided token has expired.')).to.equal(true);
    expect(isSignatureError(400, 'Invalid Compact JWS')).to.equal(true);
    expect(isSignatureError(400, 'Invalid signature')).to.equal(true);
  });

  it('leaves other failures alone', () => {
    expect(isSignatureError(500, 'jwt expired')).to.equal(false);
    expect(isSignatureError(400, 'The resource already exists')).to.equal(false);
  });
});

describe('SupabaseGateway.uploadResumableSigned', () => {
  const realFetch = globalThis.fetch;
  let tempDir: string;
  let source: { contentType: string; diskPath: string; name: string; size: number };
  let server: Server | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-signed-upload-'));
    const diskPath = path.join(tempDir, 'app.apk');
    fs.writeFileSync(diskPath, Buffer.alloc(1024, 7));
    source = { contentType: 'application/vnd.android.package-archive', diskPath, name: 'app.apk', size: 1024 };

    // The publishable key comes from the API's /cli-config.
    resetCliConfigCache();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ supabase_publishable_key: 'sb_publishable_test' }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetCliConfigCache();
    server?.close();
    server = undefined;
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  const signed: SignedUpload = { expiresInSeconds: 7200, path: '1/binaries/android/abc.apk', token: 't1' };

  it('sends the token to the signed endpoint for the final path, without upsert', async () => {
    const tus = await startTusServer(() => false);
    server = tus.server;

    await SupabaseGateway.uploadResumableSigned('dev', signed, source, async () => {
      throw new Error('no refresh expected');
    }, false, { storageUrl: tus.url });

    expect(tus.seen).to.have.length(1);
    expect(tus.seen[0]).to.include({
      method: 'POST',
      objectName: '1/binaries/android/abc.apk',
      signature: 't1',
      url: '/storage/v1/upload/resumable/sign',
    });
    expect(tus.seen[0].upsert).to.equal(undefined);
  });

  it('gets a fresh token and carries on when the token is refused', async () => {
    const tus = await startTusServer((signature) => signature === 't1');
    server = tus.server;
    const refreshed: string[] = [];

    await SupabaseGateway.uploadResumableSigned(
      'dev',
      signed,
      source,
      async (p) => {
        refreshed.push(p);
        return { ...signed, token: 't2' };
      },
      false,
      { retryDelays: [0, 0, 0], storageUrl: tus.url },
    );

    expect(refreshed).to.deep.equal(['1/binaries/android/abc.apk']);
    expect(tus.seen.map((r) => r.signature)).to.deep.equal(['t1', 't2']);
  });

  it('refreshes before the first request when the token is about to expire', async () => {
    const tus = await startTusServer(() => false);
    server = tus.server;

    await SupabaseGateway.uploadResumableSigned(
      'dev',
      { ...signed, expiresInSeconds: 0 },
      source,
      async () => ({ ...signed, token: 'fresh' }),
      false,
      { storageUrl: tus.url },
    );

    expect(tus.seen.map((r) => r.signature)).to.deep.equal(['fresh']);
  });

  it('gives up after a bounded number of refreshes', async () => {
    const tus = await startTusServer(() => true);
    server = tus.server;
    let refreshes = 0;

    let failure: unknown;
    try {
      await SupabaseGateway.uploadResumableSigned(
        'dev',
        signed,
        source,
        async () => {
          refreshes += 1;
          return { ...signed, token: `t${refreshes + 1}` };
        },
        false,
        { retryDelays: Array.from({ length: 20 }, () => 0), storageUrl: tus.url },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect(refreshes).to.equal(5);
  });
});

describe('uploadSupabaseCopy', () => {
  const realSigned = SupabaseGateway.uploadResumableSigned;
  const realTemp = SupabaseGateway.uploadResumable;
  const realRefresh = ApiGateway.refreshUploadToken;
  let calls: string[];

  const base = {
    apiUrl: 'http://localhost:9999',
    auth: { headers: {} } as never,
    debug: false,
    env: 'dev' as const,
    source: { contentType: 'application/zip', diskPath: '/nowhere', name: 'f.zip', size: 1 },
    tempPath: 'uploads/abc/abc.zip',
  };
  const signedUpload: SignedUpload = { expiresInSeconds: 7200, path: '1/tests/abc.zip', token: 't' };

  beforeEach(() => {
    calls = [];
    SupabaseGateway.uploadResumable = (async (_env: string, p: string) => {
      calls.push(`temp:${p}`);
    }) as typeof SupabaseGateway.uploadResumable;
  });

  afterEach(() => {
    SupabaseGateway.uploadResumableSigned = realSigned;
    SupabaseGateway.uploadResumable = realTemp;
    ApiGateway.refreshUploadToken = realRefresh;
  });

  it('goes straight to the final path when a signed upload is offered', async () => {
    SupabaseGateway.uploadResumableSigned = (async (_env: string, s: SignedUpload) => {
      calls.push(`signed:${s.path}`);
    }) as typeof SupabaseGateway.uploadResumableSigned;

    const outcome = await uploadSupabaseCopy({ ...base, signedUpload });

    expect(outcome).to.deep.equal({ direct: true, path: '1/tests/abc.zip', result: { error: null, success: true } });
    expect(calls).to.deep.equal(['signed:1/tests/abc.zip']);
  });

  it('asks the API for a fresh token for the same path', async () => {
    let refreshedFor: string | undefined;
    ApiGateway.refreshUploadToken = (async (_url: string, _auth: unknown, p: string) => {
      refreshedFor = p;
      return signedUpload;
    }) as typeof ApiGateway.refreshUploadToken;
    SupabaseGateway.uploadResumableSigned = (async (
      _env: string,
      s: SignedUpload,
      _source: unknown,
      refresh: (p: string) => Promise<SignedUpload>,
    ) => {
      await refresh(s.path);
    }) as typeof SupabaseGateway.uploadResumableSigned;

    await uploadSupabaseCopy({ ...base, signedUpload });

    expect(refreshedFor).to.equal('1/tests/abc.zip');
  });

  it('falls back to the temp path when the signed upload fails', async () => {
    SupabaseGateway.uploadResumableSigned = (async () => {
      throw new Error('refused');
    }) as typeof SupabaseGateway.uploadResumableSigned;

    const outcome = await uploadSupabaseCopy({ ...base, signedUpload });

    expect(outcome.direct).to.equal(false);
    expect(outcome.path).to.equal('uploads/abc/abc.zip');
    expect(outcome.result.success).to.equal(true);
    expect(calls).to.deep.equal(['temp:uploads/abc/abc.zip']);
  });

  it('uses the temp path when no signed upload is offered', async () => {
    const outcome = await uploadSupabaseCopy(base);

    expect(outcome.direct).to.equal(false);
    expect(calls).to.deep.equal(['temp:uploads/abc/abc.zip']);
  });
});
