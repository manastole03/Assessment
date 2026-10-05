import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { REQUEST_ID_HEADER } from '../constants/http.js';
import type { AppRequest } from '../interfaces/authenticated-user.interface.js';
import { runWithRequestContext } from '../utils/request-context.js';

const ACCEPTABLE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Gives every request an id before anything else runs: reused from the caller's `X-Request-Id`
 * when it is well-formed (so a trace spans systems), generated otherwise. It is echoed in the
 * response header, stamped on every log line and error body, and forwarded to the engine.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id = incoming && ACCEPTABLE_ID.test(incoming) ? incoming : randomUUID();
  (req as AppRequest).id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  const userAgent = req.header('user-agent')?.slice(0, 512);
  runWithRequestContext({ requestId: id, ip: req.ip, userAgent }, next);
}
