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
