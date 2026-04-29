/**
 * Structured JSON logger — process-owned implementation.
 *
 * Logs are emitted as one JSON object per line so production deployments can
 * pipe them straight into a log shipper. In development, the human-readable
 * formatter is used because tailing JSON in a terminal is painful.
 *
 * The `Logger` interface itself lives in @agentis/core so that packages
 * (adapters, skills, db) can depend on the contract without depending on
 * the apps/api process.
 */

import type { LogLevel, Logger } from '@agentis/core';

export type { LogLevel, Logger } from '@agentis/core';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  base?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const minRank = LEVEL_RANK[level];
  const pretty = opts.pretty ?? process.env.NODE_ENV !== 'production';
  const base = opts.base ?? {};

  function emit(lvl: LogLevel, msg: string, ctx?: Record<string, unknown>) {
    if (LEVEL_RANK[lvl] < minRank) return;
    const record = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...ctx };
    if (pretty) {
      const color = lvl === 'error' ? '\x1b[31m' : lvl === 'warn' ? '\x1b[33m' : lvl === 'debug' ? '\x1b[90m' : '\x1b[36m';
      const reset = '\x1b[0m';
      const ctxStr = Object.keys(ctx ?? {}).length ? ' ' + JSON.stringify(ctx) : '';
      // eslint-disable-next-line no-console
      console.log(`${color}[${record.ts}] ${lvl.toUpperCase()}${reset} ${msg}${ctxStr}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(record));
    }
  }

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (ctx) => createLogger({ level, pretty, base: { ...base, ...ctx } }),
  };
}
