/**
 * Foundation wiring phase (extracted from bootstrap).
 *
 * Constructs the dependency-free base layer of the composition root: env,
 * logger, db, event bus, vault, core stores/services, adapters, and the agent
 * tool runtime. Pure construction (no late-binding), so it runs first and its
 * products are threaded into the later phases.
 */
import { AdapterManager } from '../adapters/AdapterManager.js';
import { openDatabase } from '../db.js';
import { ActiveWorkflowRegistry } from '../engine/ActiveWorkflowRegistry.js';
import { loadEnv, type AgentisEnv } from '../env.js';
import { createInProcessEventBus } from '../event-bus.js';
import { ExtensionKvStore } from '../extensions/kv.js';
import { createLogger } from '../logger.js';
import { loadOrCreateSecrets } from '../secrets.js';
import { ActivityFeedService } from '../services/activityFeed.js';
import { AgentLibraryService } from '../services/agent/agentLibrary.js';
import { AgentMemoryService } from '../services/agent/agentMemory.js';
import { AgentToolRuntime, type AgentToolRuntimeDeps } from '../services/agent/agentToolRuntime.js';
import { ApprovalInboxService } from '../services/approvalInbox.js';
import { ArtifactService } from '../services/artifactService.js';
import { AssetStore } from '../services/assetStore.js';
import { AuditTrailService } from '../services/auditTrail.js';
import { AuthService } from '../services/auth.js';
import { BrowserPool } from '../services/browserPool.js';
import { BudgetService } from '../services/budget.js';
import { CommandIndex } from '../services/command/commandIndex.js';
import { ConversationStore } from '../services/conversation/conversationStore.js';
import { CredentialVault } from '../services/credentialVault.js';
import { LocalEmbeddingProvider, warmLocalEmbeddingModel } from '../services/embedding/embeddingProvider.js';
import { EmbeddingProviderRegistry } from '../services/embedding/embeddingProviderRegistry.js';
import { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import { ExtensionLibraryService } from '../services/extensionLibrary.js';
import { ExtensionRuntime } from '../services/extensionRuntime.js';
import { FailureReflectionService } from '../services/failureReflection.js';
import { KnowledgeBaseService } from '../services/knowledge/knowledgeBase.js';
import { LedgerService } from '../services/ledger.js';
import { McpOAuthService } from '../services/mcp/mcpOAuthService.js';
import { McpToolBridge, computerUseServerFromEnv } from '../services/mcp/mcpToolBridge.js';
import { MemoryStore } from '../services/memory/memoryStore.js';
import { OAuthService } from '../services/oauthService.js';
import { ObservabilityService } from '../services/observability.js';
import { PartialReplayService } from '../services/partialReplay.js';
import { PersonalBrainService } from '../services/personalBrain.js';
import { RegistryClient } from '../services/registryClient.js';
import { ScratchpadService } from '../services/scratchpad.js';
import { SessionMirror } from '../services/sessionMirror.js';
import { SpecialistProfileService } from '../services/specialist/specialistProfileService.js';
import { SubflowExecutor } from '../services/subflowExecutor.js';
import { ViewportStore } from '../services/viewportStore.js';
import { createWebSearchProvider } from '../services/webSearch.js';
import { WorkflowStoreService } from '../services/workflow/workflowStore.js';
import { WorkspaceHarnessRuntimeResolver, WorkspaceHarnessStructuredCompleter } from '../services/workspace/workspaceHarnessRuntime.js';
import { WorkspaceIntelligenceService } from '../services/workspace/workspaceIntelligence.js';
import { WorkspaceStoreService } from '../services/workspace/workspaceStore.js';
import { WorkspaceVolumeService } from '../services/workspace/workspaceVolume.js';
import { WorktreeManager } from '../services/worktreeManager.js';
import { loadTelemetry, type Telemetry } from '../telemetry/index.js';
import { buildAppStores } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import { and, eq } from 'drizzle-orm';
import { ColdArchiveStore } from '../services/storage/coldArchiveStore.js';

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

export async function wireFoundation(envSource: NodeJS.ProcessEnv) {
  const env = loadEnv(envSource);
  // `loadEnv` resolves AGENTIS_DATA_DIR to a concrete path, but low-level modules
  // that must not depend on the env object (e.g. the embedding provider choosing
  // its model cache) read `process.env`. Publish it here, at the composition
  // root, so "where does this install keep its data" has ONE answer everywhere.
  // Without this the embedding cache fell back to the transformers default —
  // which on a global npm install is inside node_modules and failed to load.
  process.env.AGENTIS_DATA_DIR = env.AGENTIS_DATA_DIR;
  const logger = createLogger({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' });
  logger.info('agentis.bootstrap.start', { mode: env.AGENTIS_MODE ?? 'auto' });

  const secrets = await loadOrCreateSecrets(env);
  const db = await openDatabase(env);
  if (!db.sqlite) throw new Error('SQLite handle missing — only embedded mode is supported in V1');
  if (!db.sqliteRaw) throw new Error('Raw SQLite handle missing - only embedded mode is supported in V1');
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
  // Spec-compliant OAuth for external MCP servers (discovery + DCR + PKCE) —
  // "Connect with X", distinct from the fixed-provider oauthService above.
  const mcpOAuthService = new McpOAuthService();
  const auth = new AuthService(secrets);
  const archiveStore = new ColdArchiveStore(env.AGENTIS_ARCHIVE_DIR);
  const ledger = new LedgerService(sqlite, bus, archiveStore);
  const scratchpad = new ScratchpadService(bus, logger, sqlite);
  const activity = new ActivityFeedService(sqlite, bus);
  const observability = new ObservabilityService(sqlite, bus, logger, archiveStore);
  observability.startLegacyBridge();
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
  // Per-task filesystem isolation for parallel agents (swarm subtasks each get
  // their own git worktree / temp dir instead of sharing one checkout).
  const worktreeManager = new WorktreeManager(logger);
  const workspaceHarnesses = new WorkspaceHarnessRuntimeResolver({ db: sqlite, adapters });
  const workspaceHarnessCompleter = new WorkspaceHarnessStructuredCompleter(workspaceHarnesses);

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
  // §B1.1 — ONE embedding provider owner, constructed before any memory store so
  // every store embeds writes with the workspace's configured provider (not a
  // hard-wired hashing instance). This is the keystone of the semantic-recall fix.
  const embeddingRegistry = new EmbeddingProviderRegistry(sqlite, logger);
  const embeddingResolver = embeddingRegistry.resolver();
  // The local model's ~450 MB weights are NOT bundled — they download once on
  // first use. Warm them in the background at boot so that cost (or a failure on
  // an offline/firewalled host) surfaces here, in the logs, while the operator is
  // still setting up — rather than stalling their first chat turn. Fire-and-forget
  // by design: a warm failure must never block startup, and the real embed path
  // still reports the actionable error if the model is genuinely unavailable.
  void warmLocalEmbeddingModel()
    .then(() => logger.info('embedding.model_ready'))
    .catch((err: unknown) => logger.warn('embedding.model_warm_failed', {
      detail: err instanceof Error ? err.message : String(err),
    }));
  const agentMemoryService = new AgentMemoryService(sqlite, new EpisodicMemoryStore(sqlite, logger, embeddingResolver));
  // PersonalBrain is USER-scoped (cross-workspace); there is no per-user provider
  // config, so it uses a default local (semantic) embedder until an account-level
  // setting exists. Tracked as a known §B1 gap, not an oversight.
  const personalBrain = new PersonalBrainService(sqlite, new LocalEmbeddingProvider());
  const failureReflection = new FailureReflectionService(agentMemoryService, logger);
  const specialistProfiles = new SpecialistProfileService(sqlite);
  // Agentic App stores (AGENTIC-APPS-10X §4/§5) — datastore + surfaces with
  // realtime emit wired to the bus; shared by the agent tool runtime and routes.
  const appStores = buildAppStores({ db: sqlite, bus });
  // Native Playwright runtime for `browser` nodes AND the `browser_*` agent
  // tools (lazy: Chromium installs on first use if absent). Headless Chromium,
  // capped by AGENTIS_BROWSER_CONCURRENCY.
  const browserPool = new BrowserPool(logger);
  // Shared artifact persistence/resolution — screenshots become referenceable
  // artifacts and channel attachments resolve back to bytes. The assets dir lets
  // it resolve `asset://<hash>` refs off the content-addressed store.
  const artifactService = new ArtifactService(sqlite, logger, bus, env.AGENTIS_ASSETS_DIR);
  // Content-addressed asset store — the single authority for generated media.
  const assetStore = new AssetStore(env.AGENTIS_ASSETS_DIR, artifactService, sqlite, logger);
  // External MCP tool bridge (Phase 2/3A) — makes operator-mounted MCP servers
  // (incl. an env-configured computer-use server) callable as agent tools. Same
  // outbound network policy as the /v1/mcp-servers REST routes.
  const mcpAllowPrivate = String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true';
  const computerUseServer = computerUseServerFromEnv(process.env);
  const mcpToolBridge = new McpToolBridge({
    db: sqlite,
    logger,
    // Secrets plane (MCP-CAPABILITY-PLANE §S1): servers registered with a
    // credentialId get their headers resolved from the vault at call time.
    vault: credentialVault,
    allowPrivateNetwork: mcpAllowPrivate,
    ...(computerUseServer ? { computerUse: computerUseServer } : {}),
  });
  if (computerUseServer) {
    logger.info('mcp_bridge.computer_use_enabled', { url: computerUseServer.url });
  }
  // Zero-config web search backs the `web_search` agent tool (no API key). Every
  // specialist's default toolbox advertises web_search; without a provider it
  // failed "not configured", so discovery/research agents could never search.
  const webSearchProvider = createWebSearchProvider(logger);
  const agentToolRuntimeDeps: AgentToolRuntimeDeps = {
    volume: workspaceVolume,
    knowledgeBases: knowledgeBaseService,
    workflowStore: workflowStoreService,
    agentMemory: agentMemoryService,
    memory: memoryStore,
    logger,
    webSearch: webSearchProvider,
    browser: browserPool,
    artifacts: artifactService,
    mcpBridge: mcpToolBridge,
    appData: appStores.data,
    appSurfaces: appStores.surfaces,
    resolveAppIdForWorkflow: (workspaceId, workflowId) => {
      const row = sqlite
        .select({ appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId)))
        .get();
      return row?.appId ?? undefined;
    },
  };
  const agentToolRuntime = new AgentToolRuntime(agentToolRuntimeDeps);
  return {
    env,
    logger,
    secrets,
    db,
    sqlite,
    bus,
    credentialVault,
    allowedOrigins,
    oauthService,
    mcpOAuthService,
    auth,
    archiveStore,
    ledger,
    scratchpad,
    activity,
    observability,
    approvals,
    extensionKv,
    extensions,
    telemetry,
    adapters,
    worktreeManager,
    workspaceHarnesses,
    workspaceHarnessCompleter,
    subflows,
    conversations,
    sessionMirror,
    extensionRegistry,
    replay,
    commandIndex,
    registry,
    viewportStore,
    knowledgeBaseService,
    auditTrail,
    budgetService,
    workflowStoreService,
    workspaceStoreService,
    workspaceVolume,
    memoryStore,
    workspaceIntelligence,
    extensionLibrary,
    agentLibrary,
    embeddingRegistry,
    embeddingResolver,
    agentMemoryService,
    personalBrain,
    failureReflection,
    specialistProfiles,
    appStores,
    browserPool,
    artifactService,
    assetStore,
    mcpAllowPrivate,
    computerUseServer,
    mcpToolBridge,
    webSearchProvider,
    agentToolRuntimeDeps,
    agentToolRuntime,
  };
}
