/**
 * Socket.io bridge.
 *
 * Subscribes to the in-process `EventBus` and re-emits each envelope to the
 * matching room. Clients authenticate with the same JWT as the REST API by
 * passing it as `auth.token` in the socket handshake.
 *
 * Room policy:
 *  - clients only ever join rooms that match resources their workspace
 *    context covers. Cross-workspace subscriptions are refused.
 *  - presence events (focus/blur/typing/thinking) are ephemeral; the bridge
 *    forwards them but does not persist them anywhere (V1-SPEC §12.2).
 */

import { Server as IOServer, type ServerOptions } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { eq } from 'drizzle-orm';
import { REALTIME_ROOMS, AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { AuthService } from '../services/auth.js';

export interface RealtimeServer {
  attach(server: HttpServer): void;
  close(): Promise<void>;
}

export function createRealtimeServer(deps: {
  bus: EventBus;
  auth: AuthService;
  db: AgentisSqliteDb;
  logger: Logger;
  options?: Partial<ServerOptions>;
}): RealtimeServer {
  let io: IOServer | null = null;

  return {
    attach(server) {
      io = new IOServer(server, {
        cors: { origin: true, credentials: true },
        ...deps.options,
      });

      io.use(async (socket, next) => {
        try {
          const token =
            (socket.handshake.auth?.token as string | undefined) ??
            socket.handshake.headers.authorization?.replace(/^Bearer /i, '');
          if (!token) throw new AgentisError('AUTH_TOKEN_INVALID', 'Missing token');
          const claims = await deps.auth.verify(token, 'access');
          socket.data.userId = claims.sub;
          next();
        } catch (err) {
          next(err instanceof Error ? err : new Error('Auth failed'));
        }
      });

      io.on('connection', (socket) => {
        const userId = socket.data.userId as string;
        socket.join(REALTIME_ROOMS.user(userId));

        socket.on('subscribe:workspace', (workspaceId: string) => {
          if (!ownsWorkspace(deps.db, userId, workspaceId)) return;
          socket.join(REALTIME_ROOMS.workspace(workspaceId));
        });
        socket.on('subscribe:run', (args: { workspaceId: string; runId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          // Cross-check: run belongs to workspace.
          const run = deps.db
            .select()
            .from(schema.workflowRuns)
            .where(eq(schema.workflowRuns.id, args.runId))
            .get();
          if (!run || run.workspaceId !== args.workspaceId) return;
          socket.join(REALTIME_ROOMS.run(args.runId));
        });
        socket.on('subscribe:workflow', (args: { workspaceId: string; workflowId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.workflow(args.workflowId));
        });
        socket.on('subscribe:gateway', (args: { workspaceId: string; gatewayId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.gateway(args.gatewayId));
        });
        socket.on('subscribe:agent', (args: { workspaceId: string; agentId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.agent(args.agentId));
        });
        socket.on('subscribe:conversation', (args: { workspaceId: string; agentId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.conversation(args.agentId));
        });
      });

      // Single subscription bridges every published envelope to its room.
      deps.bus.subscribe(({ room, envelope }) => {
        io?.to(room).emit(envelope.event, envelope);
      });

      deps.logger.info('realtime.attached');
    },
    async close() {
      await io?.close();
    },
  };
}

function ownsWorkspace(db: AgentisSqliteDb, userId: string, workspaceId: string): boolean {
  const ws = db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();
  return !!ws && ws.userId === userId;
}
