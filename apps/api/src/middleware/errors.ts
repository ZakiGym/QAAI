/**
 * Terminal error handler. Every response the client sees on a failure comes
 * from here, in one envelope: `{ error: { code, message, details?, requestId } }`.
 *
 * Anything that is not an ApiError is a bug, and its message never reaches the
 * client — an unhandled exception's text routinely contains a query, a path, or
 * a value that should not leave the process.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';
import { currentRequestId, logger } from '../lib/logger.js';
import { isProd } from '../env.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      requestId: currentRequestId(),
    },
  });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const requestId = currentRequestId();

  if (err instanceof ApiError) {
    // 4xx is the client's problem and expected traffic; only 5xx is ours.
    logger[err.status >= 500 ? 'error' : 'info'](
      { err, code: err.code, status: err.status },
      'request failed',
    );
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }

  if (err instanceof ZodError) {
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
    logger.info({ err, type: bodyParser.type, status: parserStatus }, 'request body rejected');
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

  logger.error({ err }, 'unhandled error');
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
