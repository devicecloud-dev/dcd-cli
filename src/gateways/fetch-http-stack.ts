import { Readable } from 'node:stream';

import type { HttpRequest, HttpResponse, HttpStack } from 'tus-js-client';

/**
 * A tus `HttpStack` that sends each request with `fetch` and a fully-read body.
 *
 * tus-js-client's default Node stack pipes the chunk into a `node:http`
 * request. Under Bun (the standalone `dcd` binary is `bun build --compile`d),
 * that fails on the upload-creating POST with "The socket connection was
 * closed unexpectedly", so every Storage upload from the binary failed while
 * the npm package, on Node, worked. Bun's own `fetch` sends the same request
 * fine, so the binary uses this stack instead (see `tusHttpStack`).
 *
 * Each body is read into memory before it is sent. tus sends at most one
 * chunk per request (6 MB for Supabase), so that is one chunk at a time.
 * `fetch` can't report upload progress, so progress moves once per chunk.
 */
export class FetchHttpStack implements HttpStack {
  createRequest(method: string, url: string): HttpRequest {
    return new FetchHttpRequest(method, url);
  }

  getName(): string {
    return 'FetchHttpStack';
  }
}

class FetchHttpRequest implements HttpRequest {
  private readonly controller = new AbortController();
  private readonly headers: Record<string, string> = {};
  private progress: (bytesSent: number) => void = () => {};

  constructor(
    private readonly method: string,
    private readonly url: string,
  ) {}

  getMethod(): string {
    return this.method;
  }

  getURL(): string {
    return this.url;
  }

  setHeader(header: string, value: string): void {
    this.headers[header] = value;
  }

  getHeader(header: string): string | undefined {
    return this.headers[header];
  }

  setProgressHandler(handler: (bytesSent: number) => void): void {
    this.progress = handler;
  }

  async send(body?: unknown): Promise<HttpResponse> {
    const data = await readBody(body);
    const res = await fetch(this.url, {
      method: this.method,
      headers: this.headers,
      body: data,
      signal: this.controller.signal,
    });
    if (data) this.progress(data.byteLength);
    const text = await res.text();
    return new FetchHttpResponse(res, text);
  }

  abort(): Promise<void> {
    this.controller.abort();
    return Promise.resolve();
  }

  getUnderlyingObject(): unknown {
    return this.controller;
  }
}

class FetchHttpResponse implements HttpResponse {
  constructor(
    private readonly res: Response,
    private readonly body: string,
  ) {}

  getStatus(): number {
    return this.res.status;
  }

  getHeader(header: string): string | undefined {
    return this.res.headers.get(header) ?? undefined;
  }

  getBody(): string {
    return this.body;
  }

  getUnderlyingObject(): unknown {
    return this.res;
  }
}

/** The slice tus hands to `send`: nothing, a Buffer, or a file ReadStream. */
async function readBody(body: unknown): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (body === null || body === undefined) return undefined;
  // A Node Buffer slice, always backed by an ArrayBuffer (not a shared one).
  if (body instanceof Uint8Array) return body as Uint8Array<ArrayBuffer>;
  if (body instanceof Readable) {
    const parts: Buffer[] = [];
    for await (const part of body) {
      parts.push(typeof part === 'string' ? Buffer.from(part) : (part as Buffer));
    }
    return Buffer.concat(parts);
  }
  throw new TypeError(`FetchHttpStack can't send a body of type ${typeof body}`);
}

/**
 * tus options that pick the HTTP stack: `FetchHttpStack` under Bun, and no
 * key at all under Node, so tus keeps its default stack (what the npm package
 * has always used). It must be no key, not `httpStack: undefined`: tus spreads
 * the options over its defaults, so an `undefined` would replace the default.
 */
export function tusHttpStackOptions(
  isBun = 'bun' in process.versions,
): { httpStack?: HttpStack } {
  return isBun ? { httpStack: new FetchHttpStack() } : {};
}
