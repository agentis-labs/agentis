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
import { and, eq, inArray } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS, type NormalizedAgentEvent, type AgentAdapter } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { loadEnv, type AgentisEnv } from './env.js';
import { createLogger, type Logger } from './logger.js';
import { loadOrCreateSecrets, type AgentisSecrets } from './secrets.js';
import { openDatabase, type DbHandle } from './db.js';
import { createInProcessEventBus, type EventBus } from './event-bus.js';
import { CredentialVault } from './services/credentialVault.js';
import { OAuthService } from './services/oauthService.js';
import { buildOAuthRoutes } from './routes/oauth.js';
import { AuthService } from './services/auth.js';
import { LedgerService } from './services/ledger.js';
import { ScratchpadService } from './services/scratchpad.js';
import { ActivityFeedService } from './services/activityFeed.js';
import { ApprovalInboxService } from './services/approvalInbox.js';
import { ExtensionRuntime } from './services/extensionRuntime.js';
import { SubflowExecutor } from './services/subflowExecutor.js';
import { ConversationStore } from './services/conversationStore.js';
import { SessionMirror } from './services/sessionMirror.js';
import { RegistryClient } from './services/registryClient.js';
import { ChannelBridge } from './services/channelBridge.js';
import { TelegramChannelAdapter } from './adapters/channels/telegram.js';
import { DiscordChannelAdapter } from './adapters/channels/discord.js';
import { SlackChannelAdapter } from './adapters/channels/slack.js';
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
import { OrchestratorModelRouter } from './services/orchestratorModelRouter.js';
import { ChannelTurnDispatcher } from './services/channelTurnDispatcher.js';
import { ChannelConnectionSupervisor } from './services/channelConnectionSupervisor.js';
import { WorkspaceAwarenessService } from './services/workspaceAwarenessService.js';
import { TranscriptionService } from './services/transcriptionService.js';
import { VisionService } from './services/visionService.js';
import { DocumentExtractionService } from './services/documentExtractionService.js';
import { ChannelIdentityService } from './services/channelIdentityService.js';
import { WorkspaceModelConfigService } from './services/workspaceModelConfigService.js';
import { WorkspaceEvaluatorRuntimeFactory } from './services/workspaceEvaluatorRuntimeFactory.js';
import { buildOrchestratorModelRoutes } from './routes/orchestratorModels.js';
import { WorkflowEngine, type EngineDeps } from './engine/WorkflowEngine.js';
import { ActiveWorkflowRegistry } from './engine/ActiveWorkflowRegistry.js';
import { TriggerRuntime } from './engine/TriggerRuntime.js';
import { ListenerRuntime } from './engine/ListenerRuntime.js';
import { ListenerHealthStore } from './engine/listener/health.js';
import { ExtensionKvStore } from './extensions/kv.js';
import { buildListenerRoutes } from './routes/listeners.js';
import { buildAgentJudge } from './engine/listener/agentJudge.js';
import { errorHandler } from './middleware/error.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { auditLog } from './middleware/auditLog.js';
import { loadTelemetry, type Telemetry } from './telemetry/index.js';
import { buildAuthRoutes } from './routes/auth.js';
import { buildBootstrapRoutes } from './routes/bootstrap.js';
import { buildJwksRoutes } from './routes/jwks.js';
import { buildWorkspaceRoutes } from './routes/workspaces.js';
import { buildWorkflowRoutes } from './routes/workflows.js';
import { buildEphemeralRoutes } from './routes/ephemeral.js';
import { buildRunRoutes } from './routes/runs.js';
import { buildExtensionRoutes } from './routes/extensions.js';
import { buildActivityRoutes } from './routes/activity.js';
import { buildApprovalRoutes } from './routes/approvals.js';
import { buildDashboardRoutes } from './routes/dashboard.js';
import { buildAgentRoutes } from './routes/agents.js';
import { buildHarnessRoutes } from './routes/harness.js';
import { buildGatewayRoutes } from './routes/gateways.js';
import { buildGatewayMutationRoutes } from './routes/gatewayMutations.js';
import { buildAmbientRoutes } from './routes/ambients.js';
import { buildSpaceRoutes } from './routes/spaces.js';
import { buildScratchpadRoutes } from './routes/scratchpad.js';
import { buildTaskRoutes } from './routes/tasks.js';
import { buildTeamRoutes } from './routes/teams.js';
import { TeamService } from './services/teams.js';
import { buildBudgetRoutes } from './routes/budgets.js';
import { BudgetService } from './services/budget.js';
import { defaultConnectorRegistry } from '@agentis/integrations';
import { WorkflowStoreService } from './services/workflowStore.js';
import { WorkspaceStoreService } from './services/workspaceStore.js';
import { WorkspaceVolumeService } from './services/workspaceVolume.js';
import { WorkspaceIntelligenceService } from './services/workspaceIntelligence.js';
import { ExtensionLibraryService } from './services/extensionLibrary.js';
import { AgentLibraryService } from './services/agentLibrary.js';
import { AgentToolRuntime, type AgentToolRuntimeDeps } from './services/agentToolRuntime.js';
import { AgentSessionService } from './services/agentSession.js';
import { AgentSessionRuntime } from './services/agentSessionRuntime.js';
import { LlmSessionAdapter } from './services/llmSessionAdapter.js';
import { PlatformModelService } from './services/platformModelService.js';
import { AgentMemoryService } from './services/agentMemory.js';
import { PersonalBrainService } from './services/personalBrain.js';
import { FailureReflectionService } from './services/failureReflection.js';
import { FeynmanReflectionService } from './services/feynmanReflection.js';
import { AbilityService } from './services/abilityService.js';
import { SpecialistLoadoutService } from './services/specialistLoadoutService.js';
import { SpecialistProfileService } from './services/specialistProfileService.js';
import { SpecialistMindService } from './services/specialistMindService.js';
import { SpecialistRuntimeService } from './services/specialistRuntimeService.js';
import { SpecialistEvalService } from './services/specialistEvalService.js';
import { SpecialistDemandRouter } from './services/specialistDemandRouter.js';
import { SpecialistTemplateService } from './services/specialistTemplateService.js';
import { AbilityCompilerService } from './services/abilityCompilerService.js';
import { AbilityCreationService } from './services/abilityCreationService.js';
import { AbilityComposer } from './services/abilityComposer.js';
import { buildAbilityRoutes } from './routes/abilities.js';
import { buildSpecialistRoutes } from './routes/specialists.js';
import { buildBrainRoutes } from './routes/brain.js';
// CORA — the Workspace Brain's organizational reasoning engine.
import { buildCoraRoutes, buildCoraWebhookRoutes } from './routes/cora.js';
import { EvidenceLedgerService } from './cora/evidenceLedger.js';
import { CoraSourceFabric } from './cora/sourceFabric.js';
import { AgentisNativeSource } from './cora/sources/agentisNativeSource.js';
import { SlackSource } from './cora/sources/slackSource.js';
import { GoogleDriveSource } from './cora/sources/googleDriveSource.js';
import { GitHubSource } from './cora/sources/githubSource.js';
import { CoraInvestigationService } from './cora/investigationService.js';
import { ClaimService } from './cora/claimService.js';
import { IdentityService } from './cora/identityService.js';
import { CoraModelService } from './cora/modelService.js';
import { CoraContextComposer } from './cora/contextComposer.js';
import { CoraMigrationService } from './cora/migrationService.js';
import { CoraDiscoveryService } from './cora/discovery.js';
import { CoraExtractionService } from './cora/extractionService.js';
import { CoraRuntime } from './cora/coraRuntime.js';
// Brain — knowledge graph + memory subsystem.
import { HashingEmbeddingProvider } from './services/embeddingProvider.js';
import { KnowledgeStore } from './services/knowledgeStore.js';
import { MemoryStore } from './services/memoryStore.js';
import { EvaluatorExampleStore } from './services/evaluatorExampleStore.js';
import { WorkflowBaselineStore } from './services/workflowBaselineStore.js';
import { RollingBaselineStore } from './services/rollingBaselineStore.js';
import { DatasetIngestion } from './services/datasetIngestion.js';
import { IntelligencePromotion } from './services/intelligencePromotion.js';
import { EpisodicMemoryStore } from './services/episodicMemoryStore.js';
import { HarnessMemoryIngestionService } from './services/harnessMemoryIngestion.js';
import { BrainComposer } from './services/brainComposer.js';
import { SharedIntelligenceService } from './services/sharedIntelligence.js';
import { CognitivePromotionQueueWorker } from './services/cognitivePromotionQueueWorker.js';
import { SessionMomentService } from './services/sessionMomentService.js';
import { PeerProfileService } from './services/peerProfileService.js';
import { ReflectionService } from './services/reflectionService.js';
import { BrainDiscourseService } from './services/brainDiscourseService.js';
import { BrainCompressionService } from './services/brainCompressionService.js';
import { BrainMaintenanceService } from './services/brainMaintenanceService.js';
import { BrainHealthService } from './services/brainHealthService.js';
import { KnowledgeAutoLinker } from './services/knowledgeAutoLinker.js';
import { EmbeddingBackfillService } from './services/embeddingBackfill.js';
import { ConfiguredBrainEnrichmentProvider, EnrichedKnowledgeGraphWriter } from './services/brainEnrichment.js';
import { ChatMemoryCaptureService } from './services/chatMemoryCapture.js';
import { BrowserPool } from './services/browserPool.js';
import { SpecialistAgentService } from './services/specialistAgents.js';
import { McpHarnessSessionService } from './services/mcpHarnessSession.js';
import { AuditTrailService } from './services/auditTrail.js';
import { InstinctEngine } from './services/instinctEngine.js';
import { buildAuditRoutes } from './routes/audit.js';
import { buildAnalyticsRoutes } from './routes/analytics.js';
import { buildMcpRoutes } from './routes/mcp.js';
import { buildMcpServerRoutes } from './routes/mcpServers.js';
import { buildA2aRoutes } from './routes/a2a.js';
import { buildInteractionRoutes } from './routes/interactions.js';
import { buildGovernanceRoutes } from './routes/governance.js';
import { buildWorkflowIoRoutes } from './routes/workflowIo.js';
import { EvaluatorRuntime } from './services/evaluatorRuntime.js';
import type { StructuredCompleter } from './services/structuredCompleter.js';
import { buildTerminalRoutes } from './routes/terminal.js';
import { buildCredentialRoutes } from './routes/credentials.js';
import { buildIntegrationRoutes } from './routes/integrations.js';
import { buildTriggerRoutes } from './routes/triggers.js';
import { buildWebhookRoutes } from './routes/webhooks.js';
import { buildSchedulerRoutes } from './routes/scheduler.js';
import { buildConversationRoutes } from './routes/conversations.js';
import { buildRoomRoutes } from './routes/rooms.js';
import { buildHistoryRoutes } from './routes/history.js';
import { buildExtensionRegistryRoutes } from './routes/extensionRegistry.js';
import { buildChannelRoutes } from './routes/channels.js';
import { buildCommandRoutes } from './routes/command.js';
import { buildReplayRoutes } from './routes/replay.js';
import { buildPackageRoutes } from './routes/packages.js';
import { PackagerService } from './services/packager.js';
import { hydrateAgentRuntimes } from './services/agentRuntimeHydrator.js';
import { buildArtifactRoutes } from './routes/artifacts.js';
import { buildWorkspaceContextRoutes } from './routes/workspaceContext.js';
import { buildWorkspaceIntelligenceRoutes } from './routes/workspaceIntelligence.js';
import { buildMemoryRoutes } from './routes/memory.js';
import { buildIssueRoutes } from './routes/issues.js';
import { buildKnowledgeBaseRoutes } from './routes/knowledgeBases.js';
import { buildPersonalBrainRoutes } from './routes/personalBrain.js';
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

/** Build an OAuth client config only when both id + secret are present. */
function oauthClient(clientId?: string, clientSecret?: string): { clientId: string; clientSecret: string } | undefined {
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function oauthProxyUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return new URL(trimmed).toString().replace(/\/+$/u, '');
}

function realtimeAllowedOrigins(env: AgentisEnv): string[] {
  const configured = env.AGENTIS_ALLOWED_ORIGINS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  if (configured?.length) return [...new Set(configured)];
  if (env.AGENTIS_PUBLIC_URL) return [new URL(env.AGENTIS_PUBLIC_URL).origin];
  return [
    `http://127.0.0.1:${env.AGENTIS_HTTP_PORT}`,
    `http://localhost:${env.AGENTIS_HTTP_PORT}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ];
}

function publishAdapterRealtime(
  event: NormalizedAgentEvent,
  deps: { db: AgentisSqliteDb; bus: EventBus; logger: Logger },
): void {
  const runId = 'runId' in event ? event.runId : undefined;
  const workflowId = 'workflowId' in event ? event.workflowId : undefined;
  if (!runId || !workflowId) return;

  const agent = deps.db
    .select({ name: schema.agents.name, workspaceId: schema.agents.workspaceId })
    .from(schema.agents)
    .where(eq(schema.agents.id, event.agentId))
    .get();
  const run = agent?.workspaceId
    ? null
    : deps.db
      .select({ workspaceId: schema.workflowRuns.workspaceId })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
  const workspaceId = agent?.workspaceId ?? run?.workspaceId;
  if (!workspaceId) {
    deps.logger.debug?.('adapter.realtime.no_workspace', { eventType: event.eventType, runId, agentId: event.agentId });
    return;
  }

  const nodeId = 'taskId' in event ? event.taskId : undefined;
  const base = {
    workspaceId,
    runId,
    workflowId,
    nodeId,
    agentId: event.agentId,
    agentName: agent?.name,
    timestamp: event.timestamp,
  };

  switch (event.eventType) {
    case 'task.started':
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, {
        ...base,
        phase: 'start',
        step: 'agent_task',
        description: 'Agent task started',
      });
      break;
    case 'task.progress':
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, {
        ...base,
        phase: 'progress',
        step: 'agent_task',
        description: clipRealtimeText(event.message),
      });
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE, {
        ...base,
        message: clipRealtimeText(event.message),
      });
      break;
    case 'agent.thinking': {
      const text = clipRealtimeText(event.text ?? '');
      if (!text) return;
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, {
        ...base,
        phase: 'thinking',
        step: 'reasoning',
        description: text,
      });
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE, {
        ...base,
        message: text,
      });
      break;
    }
    case 'agent.tool_call':
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, {
        ...base,
        phase: 'tool',
        step: event.tool,
        description: `Tool call: ${event.tool}`,
      });
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL, {
        ...base,
        tool: event.tool,
        input: event.input,
        result: event.result,
      });
      break;
    default:
      break;
  }
}

function clipRealtimeText(text: string, max = 2_000): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
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
  const allowedOrigins = realtimeAllowedOrigins(env);
  // Inline OAuth (§7): mints encrypted credentials from a "Sign in with X" popup.
  const oauthService = new OAuthService({
    baseUrl: env.AGENTIS_PUBLIC_URL ?? `http://${env.AGENTIS_HTTP_HOST}:${env.AGENTIS_HTTP_PORT}`,
    oauthProxyUrl: oauthProxyUrl(env.AGENTIS_OAUTH_PROXY_URL),
    clients: {
      google: oauthClient(env.OAUTH_GOOGLE_CLIENT_ID, env.OAUTH_GOOGLE_CLIENT_SECRET),
      slack: oauthClient(env.OAUTH_SLACK_CLIENT_ID, env.OAUTH_SLACK_CLIENT_SECRET),
      github: oauthClient(env.OAUTH_GITHUB_CLIENT_ID, env.OAUTH_GITHUB_CLIENT_SECRET),
      notion: oauthClient(env.OAUTH_NOTION_CLIENT_ID, env.OAUTH_NOTION_CLIENT_SECRET),
      linkedin: oauthClient(env.OAUTH_LINKEDIN_CLIENT_ID, env.OAUTH_LINKEDIN_CLIENT_SECRET),
      twitter_x: oauthClient(env.OAUTH_TWITTER_X_CLIENT_ID, env.OAUTH_TWITTER_X_CLIENT_SECRET),
    },
    logger,
  });
  const auth = new AuthService(secrets);
  const ledger = new LedgerService(sqlite, bus);
  const scratchpad = new ScratchpadService(bus, logger);
  const activity = new ActivityFeedService(sqlite, bus);
  const approvals = new ApprovalInboxService(sqlite, bus);
  const extensionKv = new ExtensionKvStore(sqlite);
  const extensions = new ExtensionRuntime(sqlite, logger, { dockerEnabled: !!env.AGENTIS_EXTENSION_DOCKER }, extensionKv);

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
  const extensionRegistry = new RegistryClient({
    registryUrl: env.AGENTIS_EXTENSION_REGISTRY_URL,
    timeoutMs: env.AGENTIS_EXTENSION_REGISTRY_TIMEOUT_MS,
    logger,
  });
  const replay = new PartialReplayService(sqlite);
  const commandIndex = new CommandIndex(sqlite);
  const registry = new ActiveWorkflowRegistry(sqlite, logger);
  const viewportStore = new ViewportStore();

  const knowledgeBaseService = new KnowledgeBaseService(sqlite);
  const teamService = new TeamService(sqlite, bus);
  const auditTrail = new AuditTrailService(sqlite, logger);
  const budgetService = new BudgetService({ db: sqlite, bus, approvals, audit: auditTrail });
  const workflowStoreService = new WorkflowStoreService(sqlite);
  const workspaceStoreService = new WorkspaceStoreService(sqlite);
  // Layer 1 — Workspace Intelligence: persistent context files on the Volume,
  // injected into every agent_task + the build_workflow synthesis prompt.
  const workspaceVolume = new WorkspaceVolumeService(env.AGENTIS_DATA_DIR);
  // Authored workspace context (the "charter") is stored as operator brain
  // atoms, not Markdown files — so the intelligence service is backed by the
  // memory store, which is constructed here (used again by the brain layer).
  const memoryStore = new MemoryStore(sqlite, logger);
  const workspaceIntelligence = new WorkspaceIntelligenceService(memoryStore, sqlite);
  const extensionLibrary = new ExtensionLibraryService(workspaceVolume, sqlite);
  // Principle #11 — agent identity as files: platform specialists export to
  // agents/platform/<role>.md; operator custom roles in agents/custom/*.md
  // expand the creation casting vocabulary.
  const agentLibrary = new AgentLibraryService(workspaceVolume);
  // Agent-private memory is the workspace brain scoped to one agent: it writes
  // to the canonical `memory_episodes` table (scope_id = agentId), so the same
  // episodic store backs it. A dedicated instance keeps construction order
  // simple; episodes are a stateless table writer.
  const agentMemoryService = new AgentMemoryService(sqlite, new EpisodicMemoryStore(sqlite, logger, new HashingEmbeddingProvider()));
  const personalBrain = new PersonalBrainService(sqlite, new HashingEmbeddingProvider());
  const failureReflection = new FailureReflectionService(agentMemoryService, logger);
  const abilityService = new AbilityService(sqlite, logger);
  const specialistLoadouts = new SpecialistLoadoutService(sqlite);
  const specialistProfiles = new SpecialistProfileService(sqlite);
  const agentToolRuntimeDeps: AgentToolRuntimeDeps = {
    volume: workspaceVolume,
    knowledgeBases: knowledgeBaseService,
    workflowStore: workflowStoreService,
    agentMemory: agentMemoryService,
    logger,
  };
  const agentToolRuntime = new AgentToolRuntime(agentToolRuntimeDeps);
  // Native Playwright runtime for `browser` nodes (lazy: Chromium installs on
  // first use if absent). Headless Chromium, capped by AGENTIS_BROWSER_CONCURRENCY.
  const browserPool = new BrowserPool(logger);
  let instinctEngine: InstinctEngine | undefined;
  // Layer 2 — specialist agent library: resolves agent_task.agentRole → a
  // workspace agent (seeding the built-in specialists on first use).
  const specialistAgents = new SpecialistAgentService(sqlite, agentLibrary);

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

  // Dedicated workflow-synthesis runtime (§6) — decouples `build_workflow` LLM
  // synthesis from the evaluator gate. Prefers its own endpoint; falls back to
  // the evaluator runtime; regex path when neither is configured.
  const synthesisRuntime = env.WORKFLOW_SYNTHESIS_BASE_URL
    ? new EvaluatorRuntime({
        baseUrl: env.WORKFLOW_SYNTHESIS_BASE_URL,
        apiKey: env.WORKFLOW_SYNTHESIS_API_KEY,
        model: env.WORKFLOW_SYNTHESIS_MODEL,
        logger,
      })
    : evaluatorRuntime;

  // Channel bridge (Batch 4 + OMNICHANNEL-ORCHESTRATOR-10X §3): Telegram,
  // Discord, and Slack. Inbound messages run a real orchestrator turn via the
  // ChannelTurnDispatcher wired below (after the chat executor is configured).
  const channelBridge = new ChannelBridge({
    db: sqlite,
    vault: credentialVault,
    conversations,
    bus,
    logger,
    adapters: {
      telegram: new TelegramChannelAdapter(),
      discord: new DiscordChannelAdapter(),
      slack: new SlackChannelAdapter(),
    },
  });
  channelBridge.bindOutbound();

  const seed = await seedIfEmpty({ db: sqlite, env, auth, logger });

  // Forward-declare the workspace embedding-provider resolver so the engine can
  // call it lazily after SharedIntelligence is wired below.
  let resolveAbilityEmbeddingProvider: ((workspaceId: string) => import('./services/embeddingProvider.js').EmbeddingProvider) | undefined;
  const abilityEmbeddings = (workspaceId: string) => {
    if (!resolveAbilityEmbeddingProvider) {
      // Bootstrap hasn't finished wiring SharedIntelligence yet — fall back to
      // the deterministic hashing provider so dispatch never crashes.
      return new HashingEmbeddingProvider();
    }
    return resolveAbilityEmbeddingProvider(workspaceId);
  };

  const specialistTemplates = new SpecialistTemplateService(sqlite);
  const seededSpecialistTemplates = specialistTemplates.seedPlatformTemplates();
  if (seededSpecialistTemplates > 0) logger.info('specialists.templates.seeded', { count: seededSpecialistTemplates });
  let specialistVision: VisionService | undefined;
  const specialistMind = new SpecialistMindService({
    db: sqlite,
    logger,
    embeddings: abilityEmbeddings,
    vision: () => specialistVision,
  });
  const specialistRuntime = new SpecialistRuntimeService(sqlite);
  const specialistEvals = new SpecialistEvalService(sqlite, specialistMind);
  const specialistRouter = new SpecialistDemandRouter({
    db: sqlite,
    logger,
    specialists: specialistAgents,
    profiles: specialistProfiles,
    loadouts: specialistLoadouts,
    abilities: abilityService,
    mind: specialistMind,
    runtime: specialistRuntime,
  });

  // Persistent agent sessions (SMARTER-AGENTS-10X). The cognitive loop needs a
  // function-calling LLM — but we NEVER force `.env`. The runtime is always
  // constructed and resolves its model per-workspace at dispatch time through
  // the orchestrator model router (Settings → env → first connected agent
  // runtime). When a workspace has no model anywhere, the engine's
  // `canRun(workspaceId)` gate degrades that workspace's `agent_task`s to the
  // tool loop / single-shot dispatch instead of failing.
  const sessionStore = new AgentSessionService(sqlite, logger);
  // Zero-config model derivation from the first connected agent runtime.
  const platformModel = new PlatformModelService({ db: sqlite, vault: credentialVault, logger });
  // Late-bound (assigned once the model router exists, below) per-workspace
  // session-adapter resolver + cache so the hot path reuses one adapter instance.
  let resolveSessionAdapter: ((workspaceId: string) => LlmSessionAdapter | undefined) | undefined;
  const sessionAdapterCache = new Map<string, LlmSessionAdapter>();
  // Legacy env adapter retained as an ultimate fallback for env-only deployments.
  const envSessionAdapter = (env.AGENTIS_EVALUATOR_BASE_URL && env.AGENTIS_EVALUATOR_MODEL)
    ? new LlmSessionAdapter({
        baseUrl: env.AGENTIS_EVALUATOR_BASE_URL,
        apiKey: env.AGENTIS_EVALUATOR_API_KEY,
        model: env.AGENTIS_EVALUATOR_MODEL,
        logger,
      })
    : undefined;
  const sessionRuntime = new AgentSessionRuntime({
    sessions: sessionStore,
    ...(envSessionAdapter ? { adapter: envSessionAdapter } : {}),
    resolveAdapter: (workspaceId: string) => resolveSessionAdapter?.(workspaceId),
    scratchpad,
    bus,
    logger,
    agentTools: agentToolRuntime,
  });

  // Assigned once the model router is built (below); referenced via late-bound
  // closures in engineDeps + toolHandlerDeps (both invoked lazily at run time).
  let evaluatorRuntimeFactory: WorkspaceEvaluatorRuntimeFactory | undefined;
  // LAYER 0: mints/caches a real model-backed runtime per agent (bound to its id)
  // using the workspace default model — so agent_task always has a working brain.
  let agentRuntimeResolver: ((workspaceId: string, agentId: string) => AgentAdapter | undefined) | undefined;

  const engineDeps: EngineDeps = {
    db: sqlite,
    bus,
    logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    extensions,
    adapters,
    subflows,
    knowledgeBases: knowledgeBaseService,
    conversations,
    connectors: defaultConnectorRegistry,
    workflowStore: workflowStoreService,
    workspaceStore: workspaceStoreService,
    evaluatorRuntime,
    // Per-workspace evaluation model overrides (§4.4); late-bound factory.
    resolveEvaluatorRuntime: (workspaceId: string, role: 'synthesis' | 'evaluation') => evaluatorRuntimeFactory?.for(workspaceId, role),
    resolveAgentRuntime: (workspaceId: string, agentId: string) => agentRuntimeResolver?.(workspaceId, agentId),
    vault: credentialVault,
    workspaceIntelligence,
    browserPool,
    specialists: specialistAgents,
    audit: auditTrail,
    instincts: instinctEngine,
    agentTools: agentToolRuntime,
    agentMemory: agentMemoryService,
    personalBrain,
    failureReflection,
    abilities: abilityService,
    loadouts: specialistLoadouts,
    specialistMind,
    abilityEmbeddings,
    abilityComposer: new AbilityComposer(),
    sessions: sessionStore,
    sessionRuntime,
    specialistRouter,
    telemetry,
  };
  const engine = new WorkflowEngine(engineDeps);
  // Brain — knowledge graph + memory subsystem (workspace-scoped).
  const embeddingProvider = new HashingEmbeddingProvider();
  const knowledgeStore = new KnowledgeStore(sqlite, logger, embeddingProvider);
  // memoryStore is constructed earlier (backs authored workspace context too).
  const evaluatorExampleStore = new EvaluatorExampleStore(sqlite, logger);
  const workflowBaselineStore = new WorkflowBaselineStore(sqlite);
  const datasetIngestion = new DatasetIngestion(sqlite, knowledgeStore, memoryStore, evaluatorExampleStore, logger);
  const intelligencePromotion = new IntelligencePromotion(sqlite, memoryStore, logger);
  const episodicMemoryStore = new EpisodicMemoryStore(sqlite, logger, embeddingProvider);
  const harnessMemoryIngestion = new HarnessMemoryIngestionService(episodicMemoryStore, logger);
  const brainComposer = new BrainComposer(
    sqlite,
    knowledgeStore,
    memoryStore,
    evaluatorExampleStore,
    workflowBaselineStore,
    intelligencePromotion,
    datasetIngestion,
    episodicMemoryStore,
    logger,
  );
  const rollingBaselineStore = new RollingBaselineStore(sqlite);
  const SharedIntelligence = new SharedIntelligenceService(sqlite, bus, episodicMemoryStore, logger);
  // Wire the Formation Judge model (§P3) — when an evaluator endpoint is
  // configured, run-promotion forms typed durable memory instead of staging raw
  // episodic traces. Reuses the same runtime as Brain enrichment.
  if (evaluatorRuntime) {
    SharedIntelligence.setFormationCompleter(evaluatorRuntime as unknown as StructuredCompleter);
    logger.info('brain.formation_judge.enabled', { model: env.AGENTIS_EVALUATOR_MODEL });
  } else {
    logger.info('brain.formation_judge.disabled', { reason: 'no evaluator runtime; run output is staged as episodic traces only' });
  }
  resolveAbilityEmbeddingProvider = (workspaceId: string) => SharedIntelligence.embeddingProvider(workspaceId);
  knowledgeBaseService.setEmbeddingProviderResolver((workspaceId) => SharedIntelligence.embeddingProvider(workspaceId));
  const brainEnrichment = new ConfiguredBrainEnrichmentProvider(sqlite, logger, {
    enabled: env.AGENTIS_BRAIN_ENRICHMENT_ENABLED,
    baseUrl: env.AGENTIS_EVALUATOR_BASE_URL,
    apiKey: env.AGENTIS_EVALUATOR_API_KEY,
    model: env.AGENTIS_EVALUATOR_MODEL,
    visionModel: env.AGENTIS_BRAIN_VISION_MODEL,
    transcriptionModel: env.AGENTIS_BRAIN_TRANSCRIPTION_MODEL,
  });
  const enrichedGraph = new EnrichedKnowledgeGraphWriter(sqlite, SharedIntelligence, logger, (workspaceId) => SharedIntelligence.embeddingProvider(workspaceId));
  knowledgeBaseService.setEnrichmentProvider(brainEnrichment, enrichedGraph);
  const embeddingBackfill = new EmbeddingBackfillService(knowledgeBaseService, logger);
  const brainQueue = new CognitivePromotionQueueWorker(sqlite, SharedIntelligence, logger);
  const SessionMoments = new SessionMomentService(sqlite, bus, logger);
  const PeerProfiles = new PeerProfileService(sqlite, bus, logger);
  agentToolRuntimeDeps.memory = memoryStore;
  instinctEngine = new InstinctEngine(sqlite, bus, memoryStore, logger);
  engineDeps.instincts = instinctEngine;
  engineDeps.sharedIntelligence = SharedIntelligence;
  engineDeps.brainQueue = brainQueue;
  engineDeps.peerProfiles = PeerProfiles;
  PeerProfiles.queue = brainQueue;
  brainQueue.PeerProfiles = PeerProfiles;
  const Reflection = new ReflectionService(sqlite, bus, logger, PeerProfiles, SharedIntelligence);
  brainQueue.Reflection = Reflection;
  // Phase 4 — Feynman repair loop. Reuses the evaluator runtime as its grading
  // model; without one it falls back to grounded deterministic lessons only.
  const feynmanReflection = new FeynmanReflectionService(sqlite, SharedIntelligence, logger);
  if (evaluatorRuntime) {
    feynmanReflection.setCompleter(evaluatorRuntime as unknown as StructuredCompleter);
    logger.info('brain.feynman_reflection.enabled', { model: env.AGENTIS_EVALUATOR_MODEL });
  } else {
    logger.info('brain.feynman_reflection.disabled', { reason: 'no evaluator runtime; deterministic-only repair lessons' });
  }
  brainQueue.Feynman = feynmanReflection;
  engineDeps.feynmanReflection = feynmanReflection;
  const brainDiscourse = new BrainDiscourseService(sqlite, SharedIntelligence, PeerProfiles, SessionMoments, bus, logger);
  const chatMemoryCapture = new ChatMemoryCaptureService({
    db: sqlite,
    logger,
    peerProfiles: PeerProfiles,
	    sessionMoments: SessionMoments,
	    brainQueue,
	    memory: memoryStore,
	  });
  const brainCompression = new BrainCompressionService(sqlite, logger, brainQueue);
  const brainMaintenance = new BrainMaintenanceService(sqlite, bus, logger, brainCompression, SessionMoments);
  const brainHealth = new BrainHealthService(sqlite);
  const knowledgeAutoLinker = new KnowledgeAutoLinker(
    SharedIntelligence,
    logger,
    (workspaceId) => SharedIntelligence.embeddingProvider(workspaceId),
    (args) => brainEnrichment.classifyRelation(args),
  );
  knowledgeBaseService.setAutoLinker(knowledgeAutoLinker, true);

  // Abilities V2 - Phase 6 Resilience: Startup sweep for static abilities stuck in non-ready states.
  sqlite.update(schema.abilities)
    .set({ compileStatus: 'ready', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.abilities.mode, 'static'),
        inArray(schema.abilities.compileStatus, ['pending', 'compiling', 'dirty'])
      )
    )
    .run();

  // Ability compile pipeline — drains via the cognitive promotion queue.
  const abilityCompiler = new AbilityCompilerService({
    db: sqlite,
    logger,
    abilities: abilityService,
    intelligence: SharedIntelligence,
    llm: evaluatorRuntime,
  });
  // ABILITIES-10X — the zero-cost creation engine (on-ramps + refine + self-eval).
  const abilityCreation = new AbilityCreationService({
    db: sqlite,
    logger,
    abilities: abilityService,
    llm: evaluatorRuntime,
  });
  abilityService.attachCompileHook((abilityId, workspaceId) => {
    brainQueue.enqueue({
      workspaceId,
      itemType: 'ability_review',
      priority: 'normal',
      payload: { kind: 'compile', abilityId, workspaceId },
    });
  });
  brainQueue.abilityReviewer = {
    async review(input: Record<string, unknown>): Promise<unknown> {
      const kind = typeof input?.kind === 'string' ? input.kind : null;
      const abilityId = typeof input?.abilityId === 'string' ? input.abilityId : null;
      const workspaceId = typeof input?.workspaceId === 'string' ? input.workspaceId : null;
      if (kind === 'compile' && abilityId && workspaceId) {
        await abilityCompiler.compile(abilityId, workspaceId);
      }
      return null;
    },
  };

  void rollingBaselineStore; void brainDiscourse; void brainMaintenance; void brainQueue; void abilityCompiler;
  const issues = new IssueService({ db: sqlite, bus, engine, ledger, conversations });

  // Durable job queue (polling-based, survives restarts). Started after the
  // engine is constructed; stopped on shutdown.
  const jobQueue = new DurableJobQueue({ db: sqlite, engine, logger });

  // Listener Runtime (persistent_listener v2). Its fire() is bound to the
  // TriggerRuntime constructed just below; we use a late ref to break the cycle
  // (fire is only ever invoked at runtime, after assignment).
  const listenerHealth = new ListenerHealthStore();
  let triggerRuntimeRef: TriggerRuntime;
  const listenerRuntime = new ListenerRuntime({
    db: sqlite,
    logger,
    bus,
    workflowStore: workflowStoreService,
    health: listenerHealth,
    extensionRuntime: extensions,
    agentJudge: buildAgentJudge(adapters, logger),
    fire: (args) => triggerRuntimeRef.fire(args),
    allowPrivateNetwork: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
  });

  // Trigger runtime needs the engine; wire after engine construction.
  const triggerRuntime = new TriggerRuntime({
    db: sqlite,
    logger,
    registry,
    engine,
    adapters,
    bus,
    jobQueue,
    listenerRuntime,
  });
  triggerRuntimeRef = triggerRuntime;

  const scheduler = new SchedulerService({ db: sqlite, bus, engine, logger });
  const eventChain = new EventChainService({ db: sqlite, bus, engine, logger });
  const runCompaction = new RunCompactionService({
    db: sqlite,
    logger,
    keepFullStateDays: 30,
    keepLedgerDays: 90,
  });

  const toolRegistry = new AgentisToolRegistry({ logger });
  const toolHandlerDeps = {
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
    synthesisRuntime,
    // Late-bound: the model router is constructed below. The closure is only
    // invoked at build_workflow time, by which point the factory is assigned.
    resolveEvaluatorRuntime: (workspaceId: string, role: 'synthesis' | 'evaluation') => evaluatorRuntimeFactory?.for(workspaceId, role),
    workspaceIntelligence,
    agentLibrary,
    extensionLibrary,
    abilityCreation,
    specialists: specialistAgents,
    specialistRouter,
    // Assigned once the model router is constructed below. Build handlers close
    // over this object by reference, so the late assignment is visible to them.
    modelRouter: undefined as OrchestratorModelRouter | undefined,
  };
  registerAllTools(toolRegistry, toolHandlerDeps);
  ChatToolExecutor.configure({ registry: toolRegistry, logger });

  // Workflow-dispatched agents get a concise awareness manifest of the
  // platform tools (mcp-exposed subset) so CLI agents running a node know the
  // Agentis surface exists (CHAT-10X-VISION §4.4.2). Awareness only — workflow
  // dispatch is fire-and-forget; interactive execution stays on the chat path.
  adapters.setToolManifestProvider(() =>
    toolRegistry.catalog({ mcpOnly: true }).tools.map((tool) => ({ name: tool.id, description: tool.description })),
  );

  // Orchestrator model router (OMNICHANNEL-ORCHESTRATOR-10X §4.4) — resolves a
  // model per cognition role (conversation, planning, synthesis, …). The
  // conversation role is the fast-path chat runtime: it gives the operator-facing
  // chat a native function-calling brain even when the selected agent runs on a
  // slow marker-protocol CLI (Codex / Claude Code). With only the default model
  // set, one high model serves every role; per-role env vars override.
  // Workspace situational model — the orchestrator's channel-independent
  // awareness (roster, in-motion runs, approvals, channels). OMNICHANNEL §4.1.
  const workspaceAwareness = new WorkspaceAwarenessService({ db: sqlite, logger });

  const orchestratorModelRouter = OrchestratorModelRouter.fromEnv(env, logger);
  // Per-workspace model-role overrides (§4.4) — wired into the router so the
  // conversation runtime (and any workspace-aware consumer) honors them.
  const workspaceModelConfig = new WorkspaceModelConfigService({ db: sqlite, vault: credentialVault, logger });
  orchestratorModelRouter.setConfigProvider(workspaceModelConfig.asConfigProvider());
  // Zero-config fallback: when neither Settings nor env name a model for a
  // workspace, derive one from its first connected agent runtime — so connecting
  // any HTTP/LLM agent lights up the whole autonomy stack (sessions, evaluation,
  // tool loop) without touching `.env`. Sits BELOW Settings + env in precedence.
  orchestratorModelRouter.setFallbackProvider((workspaceId) => platformModel.deriveProfile(workspaceId));
  // Now that the router exists, the session runtime can resolve its per-workspace
  // cognitive model through it (Settings → env → first connected agent).
  resolveSessionAdapter = (workspaceId: string): LlmSessionAdapter | undefined => {
    const profile = orchestratorModelRouter.profile('evaluation', workspaceId)
      ?? orchestratorModelRouter.profile('conversation', workspaceId);
    if (!profile) return undefined;
    const key = `${profile.baseUrl}|${profile.model}|${profile.apiKey ?? ''}`;
    let adapter = sessionAdapterCache.get(key);
    if (!adapter) {
      adapter = new LlmSessionAdapter({
        baseUrl: profile.baseUrl,
        ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
        model: profile.model,
        logger,
      });
      sessionAdapterCache.set(key, adapter);
    }
    return adapter;
  };
  logger.info('engine.sessions.enabled', { resolution: 'per-workspace (settings → env → first agent)' });
  // Wire the router into build_workflow so synthesis can route around a slow
  // per-call CLI harness through the configured streaming model — zero extra setup.
  toolHandlerDeps.modelRouter = orchestratorModelRouter;
  // Per-workspace synthesis/evaluation runtimes (wired into build_workflow via
  // the late-bound closure in toolHandlerDeps.resolveEvaluatorRuntime).
  evaluatorRuntimeFactory = new WorkspaceEvaluatorRuntimeFactory({ router: orchestratorModelRouter, logger });
  // LAYER 0: agent_task runtime inheritance — bind the workspace default model to
  // any agent that has no explicit adapter, so specialists actually run.
  agentRuntimeResolver = (workspaceId: string, agentId: string) => orchestratorModelRouter.resolveForAgent(agentId, workspaceId);
  const orchestratorRuntime = orchestratorModelRouter.resolve('conversation');
  logger.info('chat.orchestrator_runtime', {
    enabled: Boolean(orchestratorRuntime),
    models: orchestratorModelRouter.describe(),
  });
  ChatSessionExecutor.configure({
    db: sqlite,
    logger,
    bus,
    adapters,
    orchestratorRuntime,
    modelRouter: orchestratorModelRouter,
    agentMemory: agentMemoryService,
    personalBrain,
    workspaceIntelligence,
    knowledgeBases: knowledgeBaseService,
    brainDiscourse,
    awareness: workspaceAwareness,
    abilityService,
  });
  const mcpHarness = McpHarnessSessionService.fromEnv(env as unknown as NodeJS.ProcessEnv, sqlite, logger);

  // Cross-surface peer identity — recognizes the same human across channels.
  const channelIdentity = new ChannelIdentityService({ db: sqlite, logger });

  // Close the channel loop: inbound channel messages now run a real orchestrator
  // turn and the reply is delivered back to the origin chat.
  const channelTurnDispatcher = new ChannelTurnDispatcher({
    db: sqlite,
    adapters,
    conversations,
    logger,
    deliver: (args) => channelBridge.deliverToConnection(args),
    setTyping: (connectionId, chatId, on) => channelBridge.setTyping(connectionId, chatId, on),
    identity: channelIdentity,
    // Coalesce rapid-fire messages from the same chat into one turn.
    debounceMs: 900,
  });
  channelBridge.setTurnDispatcher(channelTurnDispatcher);

  // Voice-note transcription (WhatsApp) — uses the model router's transcription
  // role. No-op when no transcription model is configured.
  const transcription = new TranscriptionService({
    profile: () => orchestratorModelRouter.profile('transcription'),
    logger,
  });
  // Image understanding for inbound channel images — uses the vision role.
  const vision = new VisionService({
    profile: () => orchestratorModelRouter.profile('vision'),
    logger,
  });
  specialistVision = vision;
  // Document (PDF / text) extraction for inbound channel attachments.
  const documentExtraction = new DocumentExtractionService({ logger });

  // Persistent-transport supervisor: live WhatsApp (baileys) sockets. Routes
  // inbound through the same dispatcher and outbound back over the live socket.
  const channelSupervisor = new ChannelConnectionSupervisor({
    db: sqlite,
    bus,
    logger,
    vault: credentialVault,
    conversations,
    dataDir: env.AGENTIS_DATA_DIR,
    dispatcher: channelTurnDispatcher,
    ...(transcription.enabled ? { transcribeAudio: (bytes, mime) => transcription.transcribe({ bytes, mimeType: mime }) } : {}),
    ...(vision.enabled ? { describeImage: (bytes, mime, caption) => vision.describe({ bytes, mimeType: mime, ...(caption ? { caption } : {}) }) } : {}),
    extractDocument: (bytes, mime, fileName) => documentExtraction.extract({ bytes, mimeType: mime, ...(fileName ? { fileName } : {}) }),
  });
  channelBridge.setPersistentTransport(channelSupervisor);
  // Re-link any already-authenticated WhatsApp connections on boot (best-effort).
  void channelSupervisor.startAll().catch((err) => {
    logger.warn('channel.supervisor.start_all_failed', { err: (err as Error).message });
  });

  const orchestratorBridge = new OrchestratorEventBridge({ db: sqlite, bus, logger });
  orchestratorBridge.start();

  // ── Adapter event glue ──────────────────────────────────
  // 1) Engine needs task.completed/failed for node settlement.
  adapters.onEvent((event, agentId) => {
    publishAdapterRealtime(event, { db: sqlite, bus, logger });
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
    } else if (event.eventType === 'agent.thinking') {
      // LAYER 1: stream the agent's live reasoning into the run room + replay tail
      // (the workspace-room copy is handled by publishAdapterRealtime above).
      if (event.runId && event.text) {
        engine.notifyAgentActivity({ runId: event.runId, agentId, taskId: event.taskId, kind: 'thinking', text: event.text });
      }
    } else if (event.eventType === 'task.progress') {
      if (event.runId && event.message) {
        engine.notifyAgentActivity({ runId: event.runId, agentId, taskId: event.taskId, kind: 'text', text: event.message });
      }
    } else if (event.eventType === 'agent.tool_call') {
      if (event.runId) {
        engine.notifyAgentActivity({
          runId: event.runId, agentId, taskId: event.taskId,
          kind: event.result !== undefined ? 'tool_result' : 'tool_call',
          tool: event.tool, toolInput: event.input, toolResult: event.result,
        });
      }
    }
  });

  // 2) SessionMirror handles all the side-channel events
  //    (session_message, approval_requested, status, heartbeat).
  sessionMirror.bind((handler) => adapters.onEvent(handler));

  // 3) Approval resume → engine. Checkpoints complete their node; phase gates
  //    release (approve) or fail (reject) the gated phase. `targetId` carries the
  //    checkpoint node id / phase id.
  approvals.bindCheckpointHandler(async ({ runId, approvalId, decision }) => {
    await engine.resolveApproval({ runId, approvalId, decision });
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
  const sharedPackager = new PackagerService({ db: sqlite, bus, logger, abilities: abilityService });
  app.route('/v1/auth', buildAuthRoutes({ db: sqlite, auth, secrets }));
  app.route('/v1/bootstrap', buildBootstrapRoutes({
    db: sqlite,
    auth,
    bridge: channelBridge,
    vault: credentialVault,
    adapters,
    logger,
    bus,
  }));
  app.route('/v1/workspaces', buildWorkspaceRoutes({ db: sqlite, auth, bus }));
  app.route('/v1/dashboard', buildDashboardRoutes({ db: sqlite, auth }));
  app.route('/v1/activity', buildActivityRoutes({ db: sqlite, auth, activity }));
  app.route('/v1/approvals', buildApprovalRoutes({ db: sqlite, auth, approvals }));
  app.route('/v1/workflows', buildWorkflowRoutes({
    db: sqlite,
    auth,
    engine,
    bus,
    packager: sharedPackager,
    triggerRuntime,
  }));
  app.route('/v1/workflows', buildAnalyticsRoutes({ db: sqlite, auth }));
  app.route('/v1/workflows', buildWorkflowIoRoutes({ db: sqlite, auth }));
  app.route('/v1/mcp', buildMcpRoutes({ db: sqlite, auth, engine, toolRegistry }));
  app.route('/v1/mcp-servers', buildMcpServerRoutes({ db: sqlite, auth, allowPrivateNetwork: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true' }));
  app.route('/v1/a2a', buildA2aRoutes({ db: sqlite, auth, adapters, engine, activity }));
  app.route('/v1/interactions', buildInteractionRoutes({ db: sqlite, auth }));
  app.route('/v1/governance', buildGovernanceRoutes({ db: sqlite, auth, adapters }));
  app.route('/v1/ephemeral', buildEphemeralRoutes({ db: sqlite, auth, engine, bus }));
  app.route('/v1/runs', buildRunRoutes({ db: sqlite, auth, engine, ledger, scratchpad, bus }));
  app.route('/v1/runs', buildReplayRoutes({ db: sqlite, auth, engine, replay }));
  app.route('/v1/runs', buildAuditRoutes({ db: sqlite, auth, audit: auditTrail }));
  app.route('/v1/extensions', buildExtensionRoutes({ db: sqlite, auth, extensionLibrary, runtime: extensions, kv: extensionKv }));
  app.route('/v1/packages', buildPackageRoutes({ db: sqlite, auth, bus, logger, abilities: abilityService }));
  app.route('/v1/artifacts', buildArtifactRoutes({ db: sqlite, auth, bus }));
  app.route('/v1/workspace-context', buildWorkspaceContextRoutes({ db: sqlite, auth, intelligence: workspaceIntelligence }));
  app.route('/v1/workspace/intelligence', buildWorkspaceIntelligenceRoutes({ db: sqlite, auth, intelligence: SharedIntelligence, backfill: embeddingBackfill, logger }));
  app.route('/v1/memory', buildMemoryRoutes({ db: sqlite, auth, memory: memoryStore, episodes: episodicMemoryStore }));
  // CORA — evidence ledger, source fabric, claims, grants, migration. The
  // claim service hears about evidence invalidation; the dispatch composer is
  // wired into SharedIntelligence (extends buildDispatchContext, RFC §12.2).
  const coraLedger = new EvidenceLedgerService({ db: sqlite, logger });
  const coraClaims = new ClaimService({ db: sqlite, logger, ledger: coraLedger });
  coraLedger.setInvalidationHandler(coraClaims.onEvidenceInvalidated);
  const coraIdentity = new IdentityService({ db: sqlite, logger });
  const coraFabric = new CoraSourceFabric({
    db: sqlite,
    logger,
    ledger: coraLedger,
    vault: credentialVault,
    identity: coraIdentity,
  });
  coraFabric.register(new AgentisNativeSource(sqlite));
  coraFabric.register(new SlackSource());
  coraFabric.register(new GoogleDriveSource());
  coraFabric.register(new GitHubSource());
  const coraModel = new CoraModelService({ db: sqlite, logger, claims: coraClaims });
  const coraComposer = new CoraContextComposer({ db: sqlite, logger });
  const coraMigration = new CoraMigrationService({ db: sqlite, logger, claims: coraClaims });
  const coraDiscovery = new CoraDiscoveryService({ db: sqlite, logger, fabric: coraFabric, composer: coraComposer });
  const coraExtraction = new CoraExtractionService({
    db: sqlite,
    logger,
    claims: coraClaims,
    identity: coraIdentity,
    migration: coraMigration,
  });
  // Adaptive-mode extraction reuses the Formation Judge's model source: when an
  // evaluator runtime is configured, free-text evidence gets model extraction;
  // otherwise Adaptive is an honest no-op (Core mode still extracts native shapes).
  const coraInvestigations = new CoraInvestigationService({ db: sqlite, logger, claims: coraClaims });
  if (evaluatorRuntime) {
    coraExtraction.setAdaptiveCompleter(evaluatorRuntime as unknown as StructuredCompleter);
    coraInvestigations.setCompleter(evaluatorRuntime as unknown as StructuredCompleter);
  }
  const coraRuntime = new CoraRuntime({
    db: sqlite,
    logger,
    fabric: coraFabric,
    extraction: coraExtraction,
    model: coraModel,
    discovery: coraDiscovery,
  });
  SharedIntelligence.setCoraComposer(coraComposer);
  app.route('/v1/cora', buildCoraRoutes({
    db: sqlite,
    auth,
    fabric: coraFabric,
    ledger: coraLedger,
    claims: coraClaims,
    identity: coraIdentity,
    model: coraModel,
    composer: coraComposer,
    migration: coraMigration,
    discovery: coraDiscovery,
    runtime: coraRuntime,
    investigations: coraInvestigations,
  }));
  // Separate prefix: /v1/cora/* is auth-gated; webhook ingress must not nest under it.
  app.route('/v1/cora-webhooks', buildCoraWebhookRoutes({ fabric: coraFabric }));
  app.route('/v1/brain', buildBrainRoutes({
    db: sqlite,
    auth,
    brain: brainComposer,
    SharedIntelligence,
    knowledgeAutoLinker,
    health: brainHealth,
    Reflection,
    agentMemory: agentMemoryService,
    peerProfiles: PeerProfiles,
    sessionMoments: SessionMoments,
  }));
  app.route('/v1/abilities', buildAbilityRoutes({ db: sqlite, auth, abilities: abilityService, creation: abilityCreation }));
  app.route('/v1/specialists', buildSpecialistRoutes({
    db: sqlite,
    auth,
    specialists: specialistAgents,
    agentLibrary,
    loadouts: specialistLoadouts,
    abilities: abilityService,
    profiles: specialistProfiles,
    mind: specialistMind,
    router: specialistRouter,
    runtime: specialistRuntime,
    evals: specialistEvals,
    templates: specialistTemplates,
  }));
  app.route('/v1/personal-brain', buildPersonalBrainRoutes({ db: sqlite, auth, brain: personalBrain }));
  app.route('/v1/issues', buildIssueRoutes({ db: sqlite, auth, issues, replay, engine }));
  app.route('/v1/knowledge-bases', buildKnowledgeBaseRoutes({ db: sqlite, auth, knowledge: knowledgeBaseService }));
  app.route('/v1/tools', buildToolRoutes({ db: sqlite, auth, toolRegistry }));
  app.route('/v1/agents', buildAgentRoutes({ db: sqlite, auth, vault: credentialVault, adapters, logger, conversations, harnessMemoryIngestion, mcpHarness }));
  app.route('/v1/spaces', buildSpaceRoutes({ db: sqlite, auth, logger, adapters, bus }));
  app.route('/v1/harness', buildHarnessRoutes({ db: sqlite, auth }));
  app.route('/v1/adapters', buildHarnessRoutes({ db: sqlite, auth }));
  app.route('/v1/agents', buildTerminalRoutes({ db: sqlite, auth, conversations }));
  app.route('/v1/gateways', buildGatewayRoutes({ db: sqlite, auth, vault: credentialVault }));
  app.route('/v1/gateways', buildGatewayMutationRoutes({ db: sqlite, auth, vault: credentialVault }));
  app.route('/v1/ambients', buildAmbientRoutes({ db: sqlite, auth }));
  app.route('/v1/budgets', buildBudgetRoutes({ db: sqlite, auth, budget: budgetService }));
  app.route('/v1/command', buildCommandRoutes({ db: sqlite, auth, commandIndex }));
  app.route('/v1/scheduler', buildSchedulerRoutes({ db: sqlite, auth }));
  app.route('/v1/triggers', buildTriggerRoutes({ db: sqlite, auth, runtime: triggerRuntime }));
  app.route('/v1/listeners', buildListenerRoutes({ db: sqlite, auth, runtime: triggerRuntime }));
  app.route('/v1/webhooks', buildWebhookRoutes({ runtime: triggerRuntime, bridge: channelBridge }));
  app.route('/v1/credentials', buildCredentialRoutes({ db: sqlite, auth, vault: credentialVault }));
  app.route('/v1/oauth', buildOAuthRoutes({ db: sqlite, auth, vault: credentialVault, oauth: oauthService, allowedOrigins }));
  app.route('/v1/integrations', buildIntegrationRoutes({ db: sqlite, auth }));
  app.route('/v1/conversations', buildConversationRoutes({ db: sqlite, auth, conversations, adapters, logger, viewportStore, bus, memoryCapture: chatMemoryCapture }));
  app.route('/v1/rooms', buildRoomRoutes({ db: sqlite, auth, bus }));
  app.route('/v1/history', buildHistoryRoutes({ db: sqlite, auth }));
  app.route('/v1/channels', buildChannelRoutes({ db: sqlite, auth, bridge: channelBridge, supervisor: channelSupervisor, identity: channelIdentity }));
  app.route('/v1/orchestrator/models', buildOrchestratorModelRoutes({ db: sqlite, auth, config: workspaceModelConfig, router: orchestratorModelRouter }));
  app.route('/v1/extensions/registry', buildExtensionRegistryRoutes({ db: sqlite, auth, registry: extensionRegistry, activity }));
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
      realtime = createRealtimeServer({ bus, auth, db: sqlite, logger, viewportStore, allowedOrigins });
      realtime.attach(httpServer);
      await listenHttpServer(httpServer, {
        port: env.AGENTIS_HTTP_PORT,
        hostname: env.AGENTIS_HTTP_HOST,
      });
      // Harness-native MCP: CLI harnesses mount Agentis's own MCP server and run
      // their own tool loop in ONE invocation (no marker re-spawn). Zero-config —
      // URL auto-derived (loopback) + token auto-minted. ON by default; opt out
      // with AGENTIS_HARNESS_MCP=false.
      if (mcpHarness.enabled) logger.info('agentis.harness_mcp.enabled', { url: '(loopback)' });
      try {
        await hydrateAgentRuntimes({ db: sqlite, vault: credentialVault, adapters, logger, bus, mcpHarness });
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
      coraRuntime.start();
      runCompaction.start();
      brainQueue.start(); // ability compile pipeline + brain promotions

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
      coraRuntime.stop();
      brainQueue.stop();
      scheduler.shutdown();
      eventChain.shutdown();
      orchestratorBridge.stop();
      channelBridge.shutdown();
      await channelSupervisor.shutdown().catch((err) => logger.warn('agentis.shutdown.channel_supervisor', { err: (err as Error).message }));
      await browserPool.shutdown().catch((err) => logger.warn('agentis.shutdown.browser', { err: (err as Error).message }));
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
