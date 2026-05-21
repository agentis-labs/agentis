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
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
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
import { KnowledgeBaseService } from './services/knowledgeBase.js';
import { DurableJobQueue } from './services/jobQueue.js';
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
import { buildEphemeralRoutes } from './routes/ephemeral.js';
import { buildRunRoutes } from './routes/runs.js';
import { buildSkillRoutes } from './routes/skills.js';
import { buildActivityRoutes } from './routes/activity.js';
import { buildApprovalRoutes } from './routes/approvals.js';
import { buildDashboardRoutes } from './routes/dashboard.js';
import { buildAgentRoutes } from './routes/agents.js';
import { buildHarnessRoutes } from './routes/harness.js';
import { buildGatewayRoutes } from './routes/gateways.js';
import { buildAmbientRoutes } from './routes/ambients.js';
import { buildScratchpadRoutes } from './routes/scratchpad.js';
import { buildTaskRoutes } from './routes/tasks.js';
import { buildTeamRoutes } from './routes/teams.js';
import { TeamService } from './services/teams.js';
import { buildBudgetRoutes } from './routes/budgets.js';
import { BudgetService } from './services/budget.js';
import { defaultConnectorRegistry } from '@agentis/integrations';
import { WorkflowStoreService } from './services/workflowStore.js';
import { EvaluatorRuntime } from './services/evaluatorRuntime.js';
import { buildTerminalRoutes } from './routes/terminal.js';
import { buildCredentialRoutes } from './routes/credentials.js';
import { buildIntegrationRoutes } from './routes/integrations.js';
import { buildTriggerRoutes } from './routes/triggers.js';
import { buildWebhookRoutes } from './routes/webhooks.js';
import { buildSchedulerRoutes } from './routes/scheduler.js';
import { buildConversationRoutes } from './routes/conversations.js';
import { buildRoomRoutes } from './routes/rooms.js';
import { buildHistoryRoutes } from './routes/history.js';
import { buildSkillRegistryRoutes } from './routes/skillRegistry.js';
import { buildChannelRoutes } from './routes/channels.js';
import { buildCommandRoutes } from './routes/command.js';
import { buildReplayRoutes } from './routes/replay.js';
import { buildPackageRoutes } from './routes/packages.js';
import { PackagerService } from './services/packager.js';
import { hydrateAgentRuntimes } from './services/agentRuntimeHydrator.js';
import { buildArtifactRoutes } from './routes/artifacts.js';
import { buildIssueRoutes } from './routes/issues.js';
import { buildKnowledgeBaseRoutes } from './routes/knowledgeBases.js';
import { buildToolRoutes } from './routes/tools.js';
import { buildTestHarnessRoutes } from './routes/testHarness.js';
import { listenHttpServer } from './httpServer.js';
import { createRealtimeServer, type RealtimeServer } from './websocket/rooms.js';
import { IssueService } from './services/issues.js';
import { EventChainService, SchedulerService } from './services/scheduler.js';
import { RunCompactionService } from './services/runCompactionService.js';

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

  const knowledgeBaseService = new KnowledgeBaseService(sqlite);
  const teamService = new TeamService(sqlite, bus);
  const budgetService = new BudgetService({ db: sqlite, bus, approvals });
  const workflowStoreService = new WorkflowStoreService(sqlite);

  // EvaluatorRuntime — only constructed when an LLM endpoint is configured.
  // Without these env vars, `evaluator` nodes throw at dispatch time and
  // `router` llm_route mode falls back to first-match. This keeps v1.0 usable
  // without forcing operators to configure a model on day one.
  const evaluatorRuntime = (env.AGENTIS_EVALUATOR_BASE_URL && env.AGENTIS_EVALUATOR_MODEL)
    ? new EvaluatorRuntime({
        baseUrl: env.AGENTIS_EVALUATOR_BASE_URL,
        apiKey: env.AGENTIS_EVALUATOR_API_KEY,
        model: env.AGENTIS_EVALUATOR_MODEL,
        logger,
      })
    : undefined;
  if (!evaluatorRuntime) {
    logger.info('engine.evaluator.disabled', {
      reason: 'AGENTIS_EVALUATOR_BASE_URL or AGENTIS_EVALUATOR_MODEL not set',
    });
  }

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
    conversations,
    connectors: defaultConnectorRegistry,
    workflowStore: workflowStoreService,
    evaluatorRuntime,
    vault: credentialVault,
    telemetry,
  });
  const issues = new IssueService({ db: sqlite, bus, engine, ledger, conversations });

  // Durable job queue (polling-based, survives restarts). Started after the
  // engine is constructed; stopped on shutdown.
  const jobQueue = new DurableJobQueue({ db: sqlite, engine, logger });

  // Trigger runtime needs the engine; wire after engine construction.
  const triggerRuntime = new TriggerRuntime({
    db: sqlite,
    logger,
    registry,
    engine,
    adapters,
    bus,
    jobQueue,
  });

  const scheduler = new SchedulerService({ db: sqlite, bus, engine, logger });
  const eventChain = new EventChainService({ db: sqlite, bus, engine, logger });
  const runCompaction = new RunCompactionService({
    db: sqlite,
    logger,
    keepFullStateDays: 30,
    keepLedgerDays: 90,
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
    knowledgeBases: knowledgeBaseService,
    evaluatorRuntime,
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
  // /v1/* call to activity_events.
  app.use('/v1/*', auditLog({ activity, logger }));

  // ── Route surface (V1) ──────────────────────────────────
  const sharedPackager = new PackagerService({ db: sqlite, bus, logger });
  app.route('/v1/auth', buildAuthRoutes({ db: sqlite, auth, secrets }));
  app.route('/v1/workspaces', buildWorkspaceRoutes({ db: sqlite, auth, bus }));
  app.route('/v1/workflows', buildWorkflowRoutes({ db: sqlite, auth, engine, bus, packager: sharedPackager }));
  app.route('/v1/ephemeral', buildEphemeralRoutes({ db: sqlite, auth, engine, bus }));
  app.route('/v1/runs', buildRunRoutes({ db: sqlite, auth, engine, ledger }));
  app.route('/v1/runs', buildReplayRoutes({ db: sqlite, auth, engine, replay }));
  app.route('/v1/skills', buildSkillRoutes({ db: sqlite, auth }));
  app.route('/v1/packages', buildPackageRoutes({ db: sqlite, auth, bus, logger }));
  app.route('/v1/artifacts', buildArtifactRoutes({ db: sqlite, auth, bus }));
  app.route('/v1/issues', buildIssueRoutes({ db: sqlite, auth, issues, replay, engine }));
  app.route('/v1/knowledge-bases', buildKnowledgeBaseRoutes({ db: sqlite, auth, knowledge: knowledgeBaseService }));
  app.route('/v1/tools', buildToolRoutes({ db: sqlite, auth, toolRegistry }));
  app.route('/v1/agents', buildAgentRoutes({ db: sqlite, auth, vault: credentialVault, adapters, logger, conversations }));
  app.route('/v1/harness', buildHarnessRoutes({ db: sqlite, auth }));
  app.route('/v1/adapters', buildHarnessRoutes({ db: sqlite, auth }));
  app.route('/v1/agents', buildTerminalRoutes({ db: sqlite, auth, conversations }));
  app.route('/v1/gateways', buildGatewayRoutes({ db: sqlite, auth, vault: credentialVault }));
  app.route('/v1/scheduler', buildSchedulerRoutes({ db: sqlite, auth }));
  app.route('/v1/triggers', buildTriggerRoutes({ db: sqlite, auth, runtime: triggerRuntime }));
  app.route('/v1/webhooks', buildWebhookRoutes({ runtime: triggerRuntime, bridge: channelBridge }));
  app.route('/v1/credentials', buildCredentialRoutes({ db: sqlite, auth, vault: credentialVault }));
  app.route('/v1/integrations', buildIntegrationRoutes({ db: sqlite, auth }));
  app.route('/v1/conversations', buildConversationRoutes({ db: sqlite, auth, conversations, adapters, logger, viewportStore }));
  app.route('/v1/rooms', buildRoomRoutes({ db: sqlite, auth, bus }));
  app.route('/v1/history', buildHistoryRoutes({ db: sqlite, auth }));
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
  app.route('/v1/teams', buildTeamRoutes({ db: sqlite, auth, bus, teams: teamService }));
  app.route('/v1/budgets', buildBudgetRoutes({ db: sqlite, auth, budget: budgetService }));

  // ── Test harness (D29) ──────────────────────────────────
  // Mounted ONLY when AGENTIS_TEST_MODE=true AND NODE_ENV !== 'production'.
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
  // unknown paths to index.html. Disabled when AGENTIS_DASHBOARD_DIST is unset.
  if (env.AGENTIS_DASHBOARD_DIST) {
    const distRoot = path.resolve(env.AGENTIS_DASHBOARD_DIST);
    app.use('/*', serveStatic({ root: distRoot }));
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
      const node = createAdaptorServer({
        fetch: app.fetch,
      });
      httpServer = node as unknown as HttpServer;
      realtime = createRealtimeServer({ bus, auth, db: sqlite, logger, viewportStore });
      realtime.attach(httpServer);
      await listenHttpServer(httpServer, {
        port: env.AGENTIS_HTTP_PORT,
        hostname: env.AGENTIS_HTTP_HOST,
      });
      try {
        await hydrateAgentRuntimes({ db: sqlite, vault: credentialVault, adapters, logger, bus });
      } catch (err) {
        logger.error('agentis.agent_runtime_hydrate_failed', { err: (err as Error).message });
      }
      // Hydrate active triggers so cron schedules + persistent listeners come back online.
      try {
        await triggerRuntime.hydrate();
      } catch (err) {
        logger.error('agentis.trigger_hydrate_failed', { err: (err as Error).message });
      }
      eventChain.start();
      scheduler.start();
      jobQueue.start();
      runCompaction.start();

      // Recover runs interrupted by the previous process. Wait-only runs are
      // resumed (timers re-armed for their remaining delay); runs with
      // non-recoverable external work in flight are failed loud. See
      // WorkflowEngine.recoverInterruptedRuns.
      try {
        const recovery = await engine.recoverInterruptedRuns();
        if (recovery.resumed > 0 || recovery.failed > 0) {
          logger.info('agentis.run_recovery', recovery);
        }
      } catch (err) {
        logger.warn('agentis.run_recovery_failed', { err: (err as Error).message });
      }
      const url = `http://${env.AGENTIS_HTTP_HOST}:${env.AGENTIS_HTTP_PORT}`;
      logger.info('agentis.listening', { url });
      return { url, httpServer };
    },
    async stop() {
      logger.info('agentis.shutdown');
      runCompaction.stop();
      jobQueue.stop();
      scheduler.shutdown();
      eventChain.shutdown();
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
