/**
 * Process entrypoint for `apps/api`.
 * Used by `pnpm dev` and the published binary; the CLI re-uses bootstrap()
 * directly so it never spawns a child process.
 */

import { bootstrap } from './bootstrap.js';

async function main() {
  const handle = await bootstrap();
  const { url } = await handle.start();
  // eslint-disable-next-line no-console
  console.log(`\nAgentis is live at ${url}\n`);

  // Last-resort safety net. A workflow engine that orchestrates runs lasting
  // weeks or months MUST NOT die because one adapter stream handler, timer, or
  // best-effort DB write threw asynchronously (these escape try/catch because
  // they fire on a later tick). Previously a single FK error inside an adapter's
  // stdout handler took down the whole process — killing every live run and SSE
  // stream ("we can't see anything in realtime"). We log loudly so the bug stays
  // visible, but we keep serving.
  process.on('uncaughtException', (err) => {
    handle.logger.error('process.uncaught_exception', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
  process.on('unhandledRejection', (reason) => {
    handle.logger.error('process.unhandled_rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  const shutdown = async (signal: string) => {
    handle.logger.info('agentis.signal', { signal });
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal during bootstrap:', err);
  process.exit(1);
});

export { bootstrap } from './bootstrap.js';
