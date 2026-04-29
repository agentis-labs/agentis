/**
 * Hono middleware: error normalization.
 *
 * Turns AgentisError + ZodError into the wire-shape the dashboard expects.
 * Any other thrown value is logged at error level and returned as a generic
 * 500. The principle: never leak stack traces to clients in production.
 */

import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { AgentisError } from '@agentis/core';
import type { Logger } from '../logger.js';

export function errorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof AgentisError) {
      return c.json({ error: err.toJSON() }, err.httpStatus as 400);
    }
    if (err instanceof ZodError) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed',
            details: { issues: err.issues },
          },
        },
        422,
      );
    }
    logger.error('http.unhandled', {
      err: err instanceof Error ? err.message : String(err),
      path: c.req.path,
    });
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
      },
      500,
    );
  };
}
