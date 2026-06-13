/**
 * useVaultAuthState — a baileys `AuthenticationState` backed by the encrypted
 * `channel_auth_state` table instead of plaintext files on disk
 * (OMNICHANNEL-ORCHESTRATOR-10X §3.4/§7).
 *
 * A faithful port of baileys' `useMultiFileAuthState` shape (creds + a
 * key-value SignalKeyStore), but each value is `BufferJSON`-serialized and
 * vault-encrypted at rest. A restart re-links from the vault without a new QR,
 * and the device credentials never touch the filesystem in the clear.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from '../../services/credentialVault.js';

export interface VaultAuthStateDeps {
  db: AgentisSqliteDb;
  vault: CredentialVault;
  connectionId: string;
}

// Loaded lazily so the baileys dependency stays optional (same as the session).
type BaileysModule = typeof import('baileys');

export async function useVaultAuthState(deps: VaultAuthStateDeps): Promise<{
  state: { creds: ReturnType<BaileysModule['initAuthCreds']>; keys: unknown };
  saveCreds: () => Promise<void>;
}> {
  const baileys = (await import('baileys' as string)) as BaileysModule;
  const { initAuthCreds, BufferJSON, proto } = baileys;
  const { db, vault, connectionId } = deps;

  const readRaw = (key: string): unknown => {
    const row = db
      .select({ value: schema.channelAuthState.valueEncrypted })
      .from(schema.channelAuthState)
      .where(and(eq(schema.channelAuthState.connectionId, connectionId), eq(schema.channelAuthState.key, key)))
      .get();
    if (!row) return null;
    try {
      return JSON.parse(vault.decrypt(row.value), BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const writeRaw = (key: string, value: unknown): void => {
    const encrypted = vault.encrypt(JSON.stringify(value, BufferJSON.replacer));
    const now = new Date().toISOString();
    db.insert(schema.channelAuthState)
      .values({ connectionId, key, valueEncrypted: encrypted, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.channelAuthState.connectionId, schema.channelAuthState.key],
        set: { valueEncrypted: encrypted, updatedAt: now },
      })
      .run();
  };

  const removeKeys = (keys: string[]): void => {
    if (keys.length === 0) return;
    db.delete(schema.channelAuthState)
      .where(and(eq(schema.channelAuthState.connectionId, connectionId), inArray(schema.channelAuthState.key, keys)))
      .run();
  };

  const creds = (readRaw('creds') as ReturnType<BaileysModule['initAuthCreds']> | null) ?? initAuthCreds();

  const state = {
    creds,
    keys: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get: async (type: string, ids: string[]) => {
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          let value = readRaw(`${type}-${id}`);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
          }
          if (value) out[id] = value;
        }
        return out;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: async (data: Record<string, Record<string, unknown>>) => {
        const toRemove: string[] = [];
        for (const type of Object.keys(data)) {
          for (const id of Object.keys(data[type] ?? {})) {
            const value = data[type]![id];
            const key = `${type}-${id}`;
            if (value) writeRaw(key, value);
            else toRemove.push(key);
          }
        }
        removeKeys(toRemove);
      },
    },
  };

  const saveCreds = async (): Promise<void> => {
    writeRaw('creds', state.creds);
  };

  return { state, saveCreds };
}
