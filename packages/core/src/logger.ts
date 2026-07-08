/**
 * Logger interface â€” V1-SPEC Â§3.3 lives in @agentis/core so packages
 * (adapters, extensions, db) can depend on it without pulling apps/api.
 *
 * The interface is what consumers code against. The concrete `createLogger`
 * implementation stays in apps/api (process-owned: writes to stdout, picks
 * pretty vs JSON based on NODE_ENV).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
}



