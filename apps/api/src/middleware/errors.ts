/**
 * Terminal error handler. Every response the client sees on a failure comes
 * from here, in one envelope: `{ error: { code, message, details?, requestId } }`.
 *
 * Anything that is not an ApiError is a bug, and its message never reaches the
 * client — an unhandled exception's text routinely contains a query, a path, or
 * a value that should not leave the process.
 *
 * ─── The request id contract (§11) ──────────────────────────────────────────
 *
 * Every failure response carries a `requestId`; the same id goes out in the
 * `x-request-id` header and into the log line. That triple is the whole point —
 * a user quotes the id from an error toast and support finds the exact request
 * without asking them what they clicked. The id is minted here if it is somehow
 * missing, because a 500 carrying no id is a support ticket that can never be
 * closed.
 *
 * ─── What is logged, and what is deliberately not ───────────────────────────
 *
 * Logged: request id, method, the matched route TEMPLATE, status, error code,
 * and the exception with its stack. The actor (user and org) is stamped onto
 * every line by the logger itself.
 *
 * NOT logged, ever:
 *
 *  - `req.originalUrl`, or any query string. This API's own surface puts
 *    credentials in query parameters — SAML relay state, magic-link tokens,
 *    OAuth codes — so a URL in an error log is a credential in an error log,
 *    which is the shape of both exfiltration bugs this repo has already shipped.
 *  - `req.body`. It holds a password on the login path and plaintext secrets on
 *    the vault path. No request's body is worth that; when a body is malformed
 *    the ZodError branch already reports which fields, without their values.
 *  - Headers. `authorization` and `cookie` are in the logger's redact list, but
 *    not sending them at all is a stronger guarantee than a list somebody has
 *    to remember to extend.
 *
 * The route is the matched TEMPLATE (`/runs/:id`), never the concrete path, for
 * the same reason — a concrete path carries ids, and the template is already
 * enough to find the handler.
 */

import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';
import { currentRequestId, logger } from '../lib/logger.js';
import { apiExceptions, routeLabelFor, type ExceptionKind } from '../lib/metrics.js';
import { isProd } from '../env.js';

/**
 * The id for this response, guaranteed to be a non-empty string.
 *
 * Normally the context middleware in index.ts has already put one in
 * AsyncLocalStorage and on the response. The fallbacks are for when it has not:
 * an error thrown by middleware mounted ahead of it, or a handler that escaped
 * the async context. Those are precisely the failures nobody can reproduce, so
 * they are the ones that most need an id to quote.
 */
function requestIdFor(res: Response): string {
  const fromContext = currentRequestId();
  if (fromContext) return fromContext;

  const header = res.getHeader('x-request-id');
  if (typeof header === 'string' && header) return header;

  return randomUUID();
}

/** Keep the id quotable from the headers as well as from the body. */
function stampHeader(res: Response, requestId: string): void {
  if (!res.headersSent && !res.getHeader('x-request-id')) {
    res.setHeader('x-request-id', requestId);
  }
}

export const notFoundHandler: RequestHandler = (req, res) => {
  const requestId = requestIdFor(res);
  stampHeader(res, requestId);

  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      // `req.path`, not `req.originalUrl`: the path says what was missed, while
      // originalUrl would echo the caller's query string back at them. Truncated
      // because the caller chooses this string.
      message: `No route for ${req.method} ${req.path.slice(0, 200)}`,
      requestId,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (err, req: Request, res, _next) => {
  const requestId = requestIdFor(res);
  stampHeader(res, requestId);

  const route = routeLabelFor(req);
  const method = req.method;
  const record = (kind: ExceptionKind): void => {
    apiExceptions.inc({ route, kind });
  };

  if (err instanceof ApiError) {
    record('api');
    // 4xx is the client's problem and expected traffic; only 5xx is ours.
    logger[err.status >= 500 ? 'error' : 'info'](
      { err, requestId, method, route, status: err.status, code: err.code },
      'request failed',
    );
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }

  if (err instanceof ZodError) {
    record('validation');
    // Issue count only. Zod's issues carry field paths and messages, never the
    // offending values — but the count is all the log needs, and the caller
    // already gets the detail in the response.
    logger.info(
      { requestId, method, route, status: 400, code: 'VALIDATION_FAILED', issues: err.issues.length },
      'request failed validation',
    );
    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request body failed validation',
        details: err.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
        requestId,
      },
    });
    return;
  }

  /*
   * body-parser rejections are the CLIENT's problem, not ours.
   *
   * Malformed JSON, a body over the limit, an unsupported charset: express.json
   * and express.urlencoded throw an http-errors object carrying `type` and a 4xx
   * `status`. Falling through to the block below answered every one of them with
   * a 500 saying "something went wrong on our side" — untrue, and worse than
   * untrue on the unauthenticated surface: POST /sso/saml/:id/acs takes a
   * form-encoded body from a stranger, so anyone could mint 500s and error-level
   * log lines at will, which is how a real incident gets lost in the noise.
   */
  const bodyParser = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  const parserStatus = typeof bodyParser.status === 'number' ? bodyParser.status : bodyParser.statusCode;
  if (
    typeof bodyParser.type === 'string' &&
    bodyParser.type.startsWith('entity.') &&
    typeof parserStatus === 'number' &&
    parserStatus >= 400 &&
    parserStatus < 500
  ) {
    record('body_parser');
    // No `err` here: an entity.parse.failed carries the offending body fragment
    // in its message, and on the SAML ACS path that fragment is somebody's
    // assertion.
    logger.info(
      { requestId, method, route, status: parserStatus, type: bodyParser.type },
      'request body rejected',
    );
    res.status(parserStatus).json({
      error: {
        code: parserStatus === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message:
          parserStatus === 413
            ? 'That request body is too large.'
            : 'That request body could not be parsed.',
        requestId,
      },
    });
    return;
  }

  record('unhandled');
  /*
   * The one line in this file logged at error level with a full stack. Its
   * fields are chosen so that searching `requestId=<what the user quoted>` finds
   * it and `route` plus the stack says which handler to open — without the URL,
   * the body, or the headers that would make the log itself the liability.
   *
   * The exception's own message can still contain a value (a driver quoting the
   * parameter it choked on), which is why the logger runs every payload through
   * the secret masker before serialising. That masking is the backstop, not the
   * plan; the plan is not to log the inputs at all.
   */
  logger.error({ err, requestId, method, route, status: 500 }, 'unhandled error');

  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong on our side',
      // The real message is useful in development and dangerous in production.
      ...(isProd ? {} : { details: err instanceof Error ? err.message : String(err) }),
      requestId,
    },
  });
};
