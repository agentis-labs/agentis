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
import { REALTIME_ROOMS, AgentisError, type ViewportContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { AuthService } from '../services/auth.js';
import type { ViewportStore } from '../services/viewportStore.js';

export interface RealtimeServer {
  attach(server: HttpServer): void;
  close(): Promise<void>;
}

export function createRealtimeServer(deps: {
  bus: EventBus;
  auth: AuthService;
  db: AgentisSqliteDb;
  logger: Logger;
  viewportStore?: ViewportStore;
  allowedOrigins: readonly string[];
  options?: Partial<ServerOptions>;
}): RealtimeServer {
  let io: IOServer | null = null;

  return {
    attach(server) {
      io = new IOServer(server, {
        ...deps.options,
        cors: { origin: [...deps.allowedOrigins], credentials: true },
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
        socket.on('unsubscribe:workspace', (workspaceId: string) => {
          socket.leave(REALTIME_ROOMS.workspace(workspaceId));
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
        socket.on('unsubscribe:run', (args: { runId: string }) => {
          if (args?.runId) socket.leave(REALTIME_ROOMS.run(args.runId));
        });
        socket.on('subscribe:workflow', (args: { workspaceId: string; workflowId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          if (!resourceInWorkspace(deps.db, 'workflow', args.workflowId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.workflow(args.workflowId));
        });
        socket.on('unsubscribe:workflow', (args: { workflowId: string }) => {
          if (args?.workflowId) socket.leave(REALTIME_ROOMS.workflow(args.workflowId));
        });
        socket.on('subscribe:gateway', (args: { workspaceId: string; gatewayId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          if (!resourceInWorkspace(deps.db, 'gateway', args.gatewayId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.gateway(args.gatewayId));
        });
        socket.on('unsubscribe:gateway', (args: { gatewayId: string }) => {
          if (args?.gatewayId) socket.leave(REALTIME_ROOMS.gateway(args.gatewayId));
        });
        socket.on('subscribe:agent', (args: { workspaceId: string; agentId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          if (!resourceInWorkspace(deps.db, 'agent', args.agentId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.agent(args.agentId));
        });
        socket.on('unsubscribe:agent', (args: { agentId: string }) => {
          if (args?.agentId) socket.leave(REALTIME_ROOMS.agent(args.agentId));
        });
        socket.on('subscribe:conversation', (args: { workspaceId: string; agentId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          if (!resourceInWorkspace(deps.db, 'agent', args.agentId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.conversation(args.agentId));
        });
        socket.on('unsubscribe:conversation', (args: { agentId: string }) => {
          if (args?.agentId) socket.leave(REALTIME_ROOMS.conversation(args.agentId));
        });
        socket.on('subscribe:room', (args: { workspaceId: string; roomId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          const room = deps.db
            .select({ id: schema.rooms.id, workspaceId: schema.rooms.workspaceId })
            .from(schema.rooms)
            .where(eq(schema.rooms.id, args.roomId))
            .get();
          if (!room || room.workspaceId !== args.workspaceId) return;
          socket.join(REALTIME_ROOMS.room(args.roomId));
        });
        socket.on('unsubscribe:room', (args: { roomId: string }) => {
          if (args?.roomId) socket.leave(REALTIME_ROOMS.room(args.roomId));
        });
        socket.on('viewport_context', (context: ViewportContext) => {
          if (!context || typeof context !== 'object') return;
          const workspaceId = context.workspaceId;
          if (!workspaceId || !ownsWorkspace(deps.db, userId, workspaceId)) return;
          deps.viewportStore?.set(userId, socket.id, context);
        });
        socket.on('disconnect', () => {
          deps.viewportStore?.clear(userId, socket.id);
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

function resourceInWorkspace(
  db: AgentisSqliteDb,
  type: 'workflow' | 'gateway' | 'agent',
  id: string,
  workspaceId: string,
): boolean {
  if (type === 'workflow') {
    const row = db
      .select({ workspaceId: schema.workflows.workspaceId })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, id))
      .get();
    return row?.workspaceId === workspaceId;
  }
  if (type === 'gateway') {
    const row = db
      .select({ workspaceId: schema.openclawGateways.workspaceId })
      .from(schema.openclawGateways)
      .where(eq(schema.openclawGateways.id, id))
      .get();
    return row?.workspaceId === workspaceId;
  }
  const row = db
    .select({ workspaceId: schema.agents.workspaceId })
    .from(schema.agents)
    .where(eq(schema.agents.id, id))
    .get();
  return row?.workspaceId === workspaceId;
}
