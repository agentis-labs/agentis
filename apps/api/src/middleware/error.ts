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

/**
 * Render zod issues as one readable line: `field: why; other.field: why`.
 * A caller that only ever prints `error.message` (the dashboard does) must
 * still learn WHICH field was rejected — "Request validation failed" alone is
 * unactionable and is what makes a bad payload feel like a platform bug.
 */
export function formatZodIssues(err: ZodError, limit = 12): string {
  const issues = err.issues.slice(0, limit).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  const more = err.issues.length - issues.length;
  return issues.join('; ') + (more > 0 ? ` (+${more} more)` : '');
}

/**
 * Build a VALIDATION_FAILED error that names the offending fields in its
 * message and keeps the raw issues in `details` for structured clients.
 */
export function validationError(prefix: string, err: ZodError): AgentisError {
  return new AgentisError('VALIDATION_FAILED', `${prefix} — ${formatZodIssues(err)}`, {
    details: { issues: err.issues },
  });
}

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
            message: `Request validation failed — ${formatZodIssues(err)}`,
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
