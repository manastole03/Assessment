import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

/** Headers worth relaying from the engine; everything else (server, date, cookies) is dropped. */
const RELAYED_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'last-modified',
  'etag',
  'mcp-session-id',
  'mcp-protocol-version',
];

export interface PipeOptions {
  /** Extra or overriding response headers (e.g. a sandboxing CSP for evidence HTML). */
  headers?: Record<string, string>;
  /** Abort the upstream request when the client disconnects. */
  upstream?: AbortController;
}

/**
 * Streams an engine response to the client without buffering it: Server-Sent Events, evidence
 * files, live screenshots and MCP. Closing either side closes the other.
 */
@Injectable()
export class EngineProxyService {
  private readonly logger = new Logger(EngineProxyService.name);

  /** An AbortController that fires when the client disconnects. */
  abortOnClose(req: Request, res: Response): AbortController {
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableFinished) controller.abort();
    };
    req.on('close', abort);
    res.on('close', abort);
    return controller;
  }

  async pipe(
    upstream: globalThis.Response,
    res: Response,
    options: PipeOptions = {},
  ): Promise<void> {
    res.status(upstream.status);
    for (const name of RELAYED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) res.setHeader(name, value);

    if (!upstream.body) {
      res.end();
      return;
    }
    if (res.getHeader('content-type')?.toString().startsWith('text/event-stream')) {
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
    }

    const body = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      body.on('error', (error: Error) => {
        // Expected when the client disconnects mid-stream; anything else is worth a line.
        if (!options.upstream?.signal.aborted)
          this.logger.warn({ reason: error.message }, 'Engine stream ended early');
        if (!res.writableEnded) res.end();
        finish();
      });
      res.on('close', () => {
        body.destroy();
        finish();
      });
      body.pipe(res).on('finish', finish);
    });
  }
}
