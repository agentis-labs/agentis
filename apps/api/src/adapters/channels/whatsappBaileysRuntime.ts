export type BaileysModule = typeof import('baileys');

let cachedBaileys: { ok: true; mod: BaileysModule } | { ok: false; reason: string } | undefined;

/** Lazy OSS dependency loading keeps non-WhatsApp Agentis installations bootable. */
export async function loadBaileys() {
  if (cachedBaileys) return cachedBaileys;
  try {
    const mod = (await import('baileys' as string)) as BaileysModule & { default?: BaileysModule };
    // Baileys 7 exposes its complete API as named ESM exports. Its default is
    // only makeWASocket, so probe a helper before choosing an interop shape.
    const resolved = (typeof (mod as Partial<BaileysModule>).initAuthCreds === 'function'
      ? mod
      : mod.default) as BaileysModule | undefined;
    if (!resolved || typeof resolved.makeWASocket !== 'function') throw new Error('baileys module did not expose makeWASocket');
    cachedBaileys = { ok: true, mod: resolved };
  } catch (err) {
    cachedBaileys = { ok: false, reason: (err as Error).message };
  }
  return cachedBaileys;
}

/** Minimal pino-compatible no-op logger without adding pino to the dependency graph. */
export function silentBaileysLogger(): unknown {
  const noop = () => {};
  const logger: Record<string, unknown> = { level: 'silent' };
  for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) logger[method] = noop;
  logger.child = () => logger;
  return logger;
}
