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
