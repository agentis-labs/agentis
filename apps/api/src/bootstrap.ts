/**
 * Bootstrap composition root.
 *
 * Glue, not logic. The order is significant: env → secrets → db → services →
 * engine → http+ws → start. Reverse on shutdown.
 *
 * Returns a `{ start, stop }` handle so embedders (the CLI, tests, the desktop
 * shell later) drive the lifecycle without re-implementing the wiring.
 */

import { type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { loadEnv, type AgentisEnv } from './env.js';
import { createLogger, type Logger } from './logger.js';
import { loadOrCreateSecrets, type AgentisSecrets } from './secrets.js';
import { openDatabase, type DbHandle } from './db.js';
import { createInProcessEventBus, type EventBus } from './event-bus.js';
import { CredentialVault } from './services/credentialVault.js';
import { AuthService } from './services/auth.js';
import { LedgerService } from './services/ledger.js';
import { ScratchpadService } from './services/scratchpad.js';
import { ActivityFeedService } from './services/activityFeed.js';
import { ApprovalInboxService } from './services/approvalInbox.js';
import { SkillRuntime } from './services/skillRuntime.js';
import { SubflowExecutor } from './services/subflowExecutor.js';
import { ConversationStore } from './services/conversationStore.js';
import { SessionMirror } from './services/sessionMirror.js';
import { RegistryClient } from './services/registryClient.js';
import { ChannelBridge } from './services/channelBridge.js';
import { TelegramChannelAdapter } from './adapters/channels/telegram.js';
import { DiscordChannelAdapter } from './adapters/channels/discord.js';
import { PartialReplayService } from './services/partialReplay.js';
import { CommandIndex } from './services/commandIndex.js';
import { KnowledgeStore } from './services/knowledgeStore.js';
import { KnowledgeBaseService } from './services/knowledgeBase.js';
import { HashingEmbeddingProvider } from './services/embeddingProvider.js';
import { AppMemoryStore } from './services/appMemoryStore.js';
import { EvaluatorExampleStore } from './services/evaluatorExampleStore.js';
import { WorkflowBaselineStore } from './services/workflowBaselineStore.js';
import { DatasetIngestion } from './services/datasetIngestion.js';
import { IntelligencePromotion } from './services/intelligencePromotion.js';
import { AppCanvasService } from './services/appCanvasService.js';
import { AppIntelligenceRuntime } from './services/appIntelligenceRuntime.js';
import { EpisodicMemoryStore } from './services/episodicMemoryStore.js';
import { BrainComposer } from './services/brainComposer.js';
import { RollingBaselineStore } from './services/rollingBaselineStore.js';
import { WorkingMemoryCompactor } from './services/workingMemoryCompactor.js';
import { MemoryPromotion } from './services/memoryPromotion.js';
import { MemoryRetrieval } from './services/memoryRetrieval.js';
import { MemoryRuntime } from './services/memoryRuntime.js';
import { RunPromotionExtractor } from './services/runPromotionExtractor.js';
import { CollectiveBrainService } from './services/collectiveBrain.js';
import { AppActivation } from './services/appActivation.js';
import { AgentisToolRegistry } from './services/agentisToolRegistry.js';
import { registerAllTools } from './services/agentisToolHandlers/index.js';
import { ChatToolExecutor } from './services/chatToolExecutor.js';
import { ChatSessionExecutor } from './services/chatSessionExecutor.js';
import { OrchestratorEventBridge } from './services/orchestratorEventBridge.js';
import { ViewportStore } from './services/viewportStore.js';
import { seedIfEmpty, type SeedResult } from './services/seed.js';
import { mountOpenApi } from './openapi.js';
import { AdapterManager } from './adapters/AdapterManager.js';
import { WorkflowEngine } from './engine/WorkflowEngine.js';
import { ActiveWorkflowRegistry } from './engine/ActiveWorkflowRegistry.js';
import { TriggerRuntime } from './engine/TriggerRuntime.js';
import { errorHandler } from './middleware/error.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { auditLog } from './middleware/auditLog.js';
import { loadTelemetry, type Telemetry } from './telemetry/index.js';
import { buildAuthRoutes } from './routes/auth.js';
import { buildJwksRoutes } from './routes/jwks.js';
import { buildWorkspaceRoutes } from './routes/workspaces.js';
import { buildSpaceRoutes } from './routes/spaces.js';
import { buildWorkflowRoutes } from './routes/workflows.js';
import { buildRunRoutes } from './routes/runs.js';
import { buildSkillRoutes } from './routes/skills.js';
import { buildActivityRoutes } from './routes/activity.js';
import { buildApprovalRoutes } from './routes/approvals.js';
import { buildDashboardRoutes } from './routes/dashboard.js';
import { buildAgentRoutes } from './routes/agents.js';
import { buildHarnessRoutes } from './routes/harness.js';
import { buildGatewayRoutes } from './routes/gateways.js';
import { buildAmbientRoutes } from './routes/ambients.js';
import { buildLedgerRoutes } from './routes/ledger.js';
import { buildScratchpadRoutes } from './routes/scratchpad.js';
import { buildTaskRoutes } from './routes/tasks.js';
import { buildTerminalRoutes } from './routes/terminal.js';
import { buildCredentialRoutes } from './routes/credentials.js';
import { buildTriggerRoutes } from './routes/triggers.js';
import { buildWebhookRoutes } from './routes/webhooks.js';
import { buildConversationRoutes } from './routes/conversations.js';
import { buildRoomRoutes } from './routes/rooms.js';
import { buildSkillRegistryRoutes } from './routes/skillRegistry.js';
import { buildChannelRoutes } from './routes/channels.js';
import { buildCommandRoutes } from './routes/command.js';
import { buildReplayRoutes } from './routes/replay.js';
import { buildPackageRoutes } from './routes/packages.js';
import { PackagerService } from './services/packager.js';
import { buildArtifactRoutes } from './routes/artifacts.js';
import { buildAppRoutes } from './routes/apps.js';
import { buildBrainRoutes } from './routes/brain.js';
import { buildMemoryRoutes } from './routes/memory.js';
import { buildKnowledgeBaseRoutes } from './routes/knowledgeBases.js';
import { buildToolRoutes } from './routes/tools.js';
import { buildTestHarnessRoutes } from './routes/testHarness.js';
import { createRealtimeServer, type RealtimeServer } from './websocket/rooms.js';

export interface BootstrapResult {
  env: AgentisEnv;
  secrets: AgentisSecrets;
  logger: Logger;
  db: DbHandle;
  bus: EventBus;
  seed: SeedResult | null;
  start(): Promise<{ url: string; httpServer: HttpServer }>;
  stop(): Promise<void>;
}

export async function bootstrap(envSource: NodeJS.ProcessEnv = process.env): Promise<BootstrapResult> {
  const env = loadEnv(envSource);
  const logger = createLogger({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' });
  logger.info('agentis.bootstrap.start', { mode: env.AGENTIS_MODE ?? 'auto' });

  const secrets = await loadOrCreateSecrets(env);
  const db = await openDatabase(env);
  if (!db.sqlite) throw new Error('SQLite handle missing — only embedded mode is supported in V1');
  const sqlite = db.sqlite;

  const bus = createInProcessEventBus();
  const credentialVault = new CredentialVault(secrets.credentialKeyB64);
  const auth = new AuthService(secrets);
  const ledger = new LedgerService(sqlite, bus);
  const scratchpad = new ScratchpadService(bus, logger);
  const activity = new ActivityFeedService(sqlite, bus);
  const approvals = new ApprovalInboxService(sqlite, bus);
  const skills = new SkillRuntime(sqlite, logger, { dockerEnabled: !!env.AGENTIS_SKILL_DOCKER });

  // Telemetry (D38) — opt-in via AGENTIS_OTEL_ENDPOINT. Falls back to a
  // no-op tracer if the OTel SDK packages are not installed, so the
  // production install stays slim.
  const telemetry: Telemetry = await loadTelemetry(
    env.AGENTIS_OTEL_ENDPOINT
      ? {
          endpoint: env.AGENTIS_OTEL_ENDPOINT,
          serviceName: env.AGENTIS_OTEL_SERVICE_NAME,
          logger,
        }
      : null,
  );

  const adapters = new AdapterManager(logger, telemetry);

  // V1.1+ services.
  const subflows = new SubflowExecutor({ db: sqlite, ledger, scratchpad });
  const conversations = new ConversationStore({ db: sqlite, bus });
  const sessionMirror = new SessionMirror({ db: sqlite, bus, logger, conversations, approvals });
  const skillRegistry = new RegistryClient({
    registryUrl: env.AGENTIS_SKILL_REGISTRY_URL,
    timeoutMs: env.AGENTIS_SKILL_REGISTRY_TIMEOUT_MS,
    logger,
  });
  const replay = new PartialReplayService(sqlite);
  const commandIndex = new CommandIndex(sqlite);
  const registry = new ActiveWorkflowRegistry(sqlite, logger);
  const viewportStore = new ViewportStore();

  const embeddingProvider = new HashingEmbeddingProvider();
  const knowledgeStore = new KnowledgeStore(sqlite, logger, embeddingProvider);
  const knowledgeBaseService = new KnowledgeBaseService(sqlite);
  const appMemoryStore = new AppMemoryStore(sqlite, logger);
  const evaluatorExampleStore = new EvaluatorExampleStore(sqlite, logger);
  const workflowBaselineStore = new WorkflowBaselineStore(sqlite);
  const datasetIngestion = new DatasetIngestion(
    sqlite,
    knowledgeStore,
    appMemoryStore,
    evaluatorExampleStore,
    logger,
  );
  const intelligencePromotion = new IntelligencePromotion(sqlite, appMemoryStore, logger);
  const appCanvasService = new AppCanvasService(sqlite, logger);
  const appIntelligenceRuntime = new AppIntelligenceRuntime(
    sqlite,
    knowledgeStore,
    appMemoryStore,
    evaluatorExampleStore,
    workflowBaselineStore,
    logger,
  );
  const episodicMemoryStore = new EpisodicMemoryStore(sqlite, logger, embeddingProvider);
  const brainComposer = new BrainComposer(
    sqlite,
    knowledgeStore,
    appMemoryStore,
    evaluatorExampleStore,
    workflowBaselineStore,
    intelligencePromotion,
    datasetIngestion,
    episodicMemoryStore,
    logger,
  );
  const rollingBaselineStore = new RollingBaselineStore(sqlite);
  const workingMemoryCompactor = new WorkingMemoryCompactor(
    sqlite,
    scratchpad,
    logger,
    (runId: string) => {
      const row = sqlite.select({ workspaceId: schema.workflowRuns.workspaceId })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, runId))
        .get();
      return row?.workspaceId ?? null;
    },
  );
  const memoryPromotion = new MemoryPromotion(sqlite, episodicMemoryStore, logger);
  const memoryRetrieval = new MemoryRetrieval(
    knowledgeStore,
    episodicMemoryStore,
    evaluatorExampleStore,
    workflowBaselineStore,
    rollingBaselineStore,
    workingMemoryCompactor,
    logger,
  );
  const memoryRuntime = new MemoryRuntime(
    knowledgeStore,
    episodicMemoryStore,
    evaluatorExampleStore,
    workflowBaselineStore,
    rollingBaselineStore,
    workingMemoryCompactor,
    memoryRetrieval,
    memoryPromotion,
    logger,
  );
  const runPromotionExtractor = new RunPromotionExtractor(sqlite, memoryPromotion, logger);
  const collectiveBrain = new CollectiveBrainService(sqlite, bus, episodicMemoryStore, logger);
  const appActivation = new AppActivation(
    knowledgeStore,
    appMemoryStore,
    evaluatorExampleStore,
    workflowBaselineStore,
    logger,
    episodicMemoryStore,
  );

  // Channel bridge (Batch 4): Telegram inbound+outbound, Discord outbound-only.
  const channelBridge = new ChannelBridge({
    db: sqlite,
    vault: credentialVault,
    conversations,
    bus,
    logger,
    adapters: {
      telegram: new TelegramChannelAdapter(),
      discord: new DiscordChannelAdapter(),
    },
  });
  channelBridge.bindOutbound();

  const seed = await seedIfEmpty({ db: sqlite, env, auth, logger });

  const engine = new WorkflowEngine({
    db: sqlite,
    bus,
    logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    skills,
    adapters,
    subflows,
    knowledgeBases: knowledgeBaseService,
    collectiveBrain,
    telemetry,
  });

  // Trigger runtime needs the engine; wire after engine construction.
  const triggerRuntime = new TriggerRuntime({
    db: sqlite,
    logger,
    registry,
    engine,
    adapters,
  });

  const toolRegistry = new AgentisToolRegistry({ logger });
  registerAllTools(toolRegistry, {
    db: sqlite,
    logger,
    bus,
    engine,
    adapters,
    ledger,
    scratchpad,
    approvals,
    activity,
    replay,
    knowledge: knowledgeStore,
    knowledgeBases: knowledgeBaseService,
    appMemory: appMemoryStore,
    evaluators: evaluatorExampleStore,
    baselines: workflowBaselineStore,
    intelligence: appIntelligenceRuntime,
    promotion: intelligencePromotion,
    memory: memoryRuntime,
    episodes: episodicMemoryStore,
    memoryPromotion,
    rollingBaselines: rollingBaselineStore,
  });
  ChatToolExecutor.configure({ registry: toolRegistry, logger });
  ChatSessionExecutor.configure({ db: sqlite, logger, bus, adapters });

  const orchestratorBridge = new OrchestratorEventBridge({ db: sqlite, bus, logger });
  orchestratorBridge.start();

  // ── Adapter event glue ──────────────────────────────────
  // 1) Engine needs task.completed/failed for node settlement.
  adapters.onEvent((event) => {
    if (event.eventType === 'task.completed') {
      void engine.notifyTaskCompleted({
        runId: event.runId,
        nodeId: event.taskId, // taskId carries node binding in V1
        output: event.output,
      });
    } else if (event.eventType === 'task.failed') {
      void engine.notifyTaskFailed({
        runId: event.runId,
        nodeId: event.taskId,
        error: event.error,
      });
    }
  });

  // 2) SessionMirror handles all the side-channel events
  //    (session_message, approval_requested, status, heartbeat).
  sessionMirror.bind((handler) => adapters.onEvent(handler));

  // 3) Approval checkpoint resume → engine.
  approvals.bindCheckpointHandler(async ({ runId, approvalId }) => {
    await engine.notifyTaskCompleted({
      runId,
      nodeId: approvalId,
      output: { approved: true },
    });
  });

  bus.subscribe((msg) => {
    if (!msg.room.startsWith('workspace:')) return;
    const event = msg.envelope.event;
    if (event !== 'run.completed' && event !== 'run.failed') return;
    const payload = msg.envelope.payload as { runId?: string; status?: string; workflowId?: string } | null;
    if (!payload?.runId || !payload.status || !payload.workflowId) return;
    const row = sqlite.select({ workspaceId: schema.workflowRuns.workspaceId })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, payload.runId))
      .get();
    if (!row) return;
    try {
      const summary = runPromotionExtractor.extractAndPromote({
        workspaceId: row.workspaceId,
        runId: payload.runId,
        workflowId: payload.workflowId,
        appId: null,
        status: payload.status,
      });
      if (summary.promoted + summary.merged + summary.superseded > 0) {
        logger.info('memory.run_promotion.applied', { runId: payload.runId, status: payload.status, ...summary });
      }
    } catch (err) {
      logger.warn('memory.run_promotion.failed', { runId: payload.runId, message: (err as Error).message });
    }
    try {
      workingMemoryCompactor.dispose(payload.runId, { durable: true });
    } catch {
      // Non-critical; scratchpad eviction continues independently.
    }
  });

  const app = new Hono();
  app.onError(errorHandler(logger));
  app.use('*', securityHeaders({ productionMode: env.NODE_ENV === 'production' }));
  app.get('/healthz', (c) => c.json({
    ok: true,
    mode: db.mode,
    runtime: 'local-first',
    standardMode: 'unsupported-in-v1',
  }));
  app.route('/.well-known', buildJwksRoutes({ auth }));
  mountOpenApi(app);

  // Universal audit middleware (D38) — records every successful state-changing
  // /v1/* call to activity_events. Mounted before the route surface so the
  // post-`next()` phase sees both the auth/workspace context and the response
  // status. Routes that publish their own richer activity (skillRegistry.ts) sit on
  // the SKIP_PATHS list inside the middleware to avoid duplicate rows.
  app.use('/v1/*', auditLog({ activity, logger }));

  // ── Route surface (V1) ──────────────────────────────────
  app.route('/v1/auth', buildAuthRoutes({ db: sqlite, auth, secrets }));
  app.route('/v1/workspaces', buildWorkspaceRoutes({ db: sqlite, auth, bus }));
  // 10.14: shared packager so workflows can mirror into Packages on save.
  const sharedPackager = new PackagerService({ db: sqlite, bus });
  app.route('/v1/workflows', buildWorkflowRoutes({ db: sqlite, auth, engine, bus, packager: sharedPackager }));
  app.route('/v1/runs', buildRunRoutes({ db: sqlite, auth, engine, ledger }));
  app.route('/v1/runs', buildReplayRoutes({ db: sqlite, auth, engine, replay }));
  app.route('/v1/skills', buildSkillRoutes({ db: sqlite, auth }));
  app.route('/v1/packages', buildPackageRoutes({ db: sqlite, auth, bus, activation: appActivation }));
  app.route('/v1/artifacts', buildArtifactRoutes({ db: sqlite, auth, bus }));
  app.route('/v1/apps', buildAppRoutes({
    db: sqlite,
    auth,
    knowledge: knowledgeStore,
    appMemory: appMemoryStore,
    evaluators: evaluatorExampleStore,
    baselines: workflowBaselineStore,
    intelligence: appIntelligenceRuntime,
    promotion: intelligencePromotion,
    ingestion: datasetIngestion,
    canvas: appCanvasService,
    brain: brainComposer,
    collectiveBrain,
  }));
  app.route('/v1/brain', buildBrainRoutes({ db: sqlite, auth, brain: brainComposer, collectiveBrain }));
  app.route('/v1/memory', buildMemoryRoutes({
    db: sqlite,
    auth,
    bus,
    memory: memoryRuntime,
    promotion: memoryPromotion,
    episodes: episodicMemoryStore,
    rollingBaselines: rollingBaselineStore,
  }));
  app.route('/v1/knowledge-bases', buildKnowledgeBaseRoutes({ db: sqlite, auth, knowledge: knowledgeBaseService }));
  app.route('/v1/tools', buildToolRoutes({ db: sqlite, auth, toolRegistry }));
  app.route('/v1/agents', buildAgentRoutes({ db: sqlite, auth, vault: credentialVault, adapters, logger, conversations }));
  app.route('/v1/harness', buildHarnessRoutes({ db: sqlite, auth }));
  app.route('/v1/agents', buildTerminalRoutes({ db: sqlite, auth, conversations }));
  app.route('/v1/gateways', buildGatewayRoutes({ db: sqlite, auth, vault: credentialVault }));
  app.route('/v1/triggers', buildTriggerRoutes({ db: sqlite, auth, runtime: triggerRuntime }));
  app.route('/v1/webhooks', buildWebhookRoutes({ runtime: triggerRuntime, bridge: channelBridge }));
  app.route('/v1/credentials', buildCredentialRoutes({ db: sqlite, auth, vault: credentialVault }));
  app.route('/v1/conversations', buildConversationRoutes({ db: sqlite, auth, conversations, adapters, logger, viewportStore }));
  app.route('/v1/rooms', buildRoomRoutes({ db: sqlite, auth, bus }));
  app.route('/v1/channels', buildChannelRoutes({ db: sqlite, auth, bridge: channelBridge }));
  app.route('/v1/skills/registry', buildSkillRegistryRoutes({ db: sqlite, auth, registry: skillRegistry, activity }));
  app.route('/v1/command', buildCommandRoutes({ db: sqlite, auth, commandIndex }));
  app.route('/v1/activity', buildActivityRoutes({ db: sqlite, auth, activity }));
  app.route('/v1/approvals', buildApprovalRoutes({ db: sqlite, auth, approvals }));
  app.route('/v1/dashboard', buildDashboardRoutes({ db: sqlite, auth }));
  app.route('/v1/ambients', buildAmbientRoutes({ db: sqlite, auth }));
  app.route('/v1/spaces', buildSpaceRoutes({ db: sqlite, auth, bus }));
  app.route('/v1/runs', buildScratchpadRoutes({ db: sqlite, auth, scratchpad }));
  app.route('/v1/tasks', buildTaskRoutes({ db: sqlite, auth }));

  // ── Test harness (D29) ──────────────────────────────────
  // Mounted ONLY when AGENTIS_TEST_MODE=true AND NODE_ENV !== 'production'.
  // Defense-in-depth (D31, OWASP A05): even if AGENTIS_TEST_MODE leaks into
  // a production deploy, the NODE_ENV gate refuses the mount and logs an
  // ERROR so the misconfiguration is loud. Provides /v1/_test/reset for
  // Playwright to wipe state between specs. Unauthenticated by design.
  if (env.AGENTIS_TEST_MODE) {
    if (env.NODE_ENV === 'production') {
      logger.error('agentis.test_mode.refused', {
        reason: 'AGENTIS_TEST_MODE=true is forbidden when NODE_ENV=production',
        action: 'unset AGENTIS_TEST_MODE or change NODE_ENV',
      });
    } else {
      app.route(
        '/v1/_test',
        buildTestHarnessRoutes({ db: sqlite, auth, env, logger }),
      );
      logger.warn('agentis.test_mode.enabled', {
        reset: '/v1/_test/reset',
        seedPassword: env.AGENTIS_SEED_PASSWORD ? '<custom>' : 'test-password-1234',
        nodeEnv: env.NODE_ENV,
      });
    }
  }

  // ── Static dashboard (D21) ──────────────────────────────
  // Mount LAST so it doesn't shadow API routes. SPA fallback rewrites
  // unknown paths to index.html. Disabled when AGENTIS_DASHBOARD_DIST is unset
  // (dev mode runs Vite separately).
  if (env.AGENTIS_DASHBOARD_DIST) {
    const distRoot = path.resolve(env.AGENTIS_DASHBOARD_DIST);
    app.use('/*', serveStatic({ root: distRoot }));
    // SPA fallback: any non-asset GET that wasn't served above falls back to index.html.
    app.get('*', serveStatic({ path: 'index.html', root: distRoot }));
    logger.info('agentis.dashboard.mounted', { dist: distRoot });
  }

  let httpServer: HttpServer | undefined;
  let realtime: RealtimeServer | undefined;

  return {
    env,
    secrets,
    logger,
    db,
    bus,
    seed,
    async start() {
      const node = serve({
        fetch: app.fetch,
        port: env.AGENTIS_HTTP_PORT,
        hostname: env.AGENTIS_HTTP_HOST,
      });
      httpServer = node as unknown as HttpServer;
      realtime = createRealtimeServer({ bus, auth, db: sqlite, logger, viewportStore });
      realtime.attach(httpServer);
      // Hydrate active triggers so cron schedules + persistent listeners come back online.
      try {
        await triggerRuntime.hydrate();
      } catch (err) {
        logger.error('agentis.trigger_hydrate_failed', { err: (err as Error).message });
      }
      const url = `http://${env.AGENTIS_HTTP_HOST}:${env.AGENTIS_HTTP_PORT}`;
      logger.info('agentis.listening', { url });
      return { url, httpServer };
    },
    async stop() {
      logger.info('agentis.shutdown');
      orchestratorBridge.stop();
      channelBridge.shutdown();
      await registry.shutdown().catch((err) => logger.warn('agentis.shutdown.registry', { err: (err as Error).message }));
      for (const reg of adapters.list()) {
        await adapters.unregister(reg.agentId).catch(() => {});
      }
      await realtime?.close();
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
      await db.close();
      await telemetry.shutdown().catch((err) => logger.warn('agentis.shutdown.telemetry', { err: (err as Error).message }));
    },
  };
}
