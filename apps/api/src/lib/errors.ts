/**
 * One error vocabulary for the whole API. Handlers throw these; the terminal
 * error middleware turns them into a stable JSON envelope. Anything that is not
 * an ApiError is a bug and becomes an opaque 500 — internal messages never
 * reach the client.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Safe to show the caller: field-level validation detail, limits, etc. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have access to this') =>
  new ApiError(403, 'FORBIDDEN', message);

/**
 * Used for both "does not exist" and "exists but not yours" — the two must be
 * indistinguishable or the API becomes an existence oracle.
 */
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, 'CONFLICT', message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new ApiError(422, 'UNPROCESSABLE', message, details);

export const rateLimited = (message = 'Too many requests') =>
  new ApiError(429, 'RATE_LIMITED', message);

/** Plan limit hit (§9). Carries the limit so the UI can offer the right upgrade. */
export const planLimit = (message: string, details: { limit: string; plan: string }) =>
  new ApiError(402, 'PLAN_LIMIT', message, details);

export const notImplemented = (what: string) =>
  new ApiError(501, 'NOT_IMPLEMENTED', `${what} is not implemented yet`);
