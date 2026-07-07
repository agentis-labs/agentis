/**
 * Agentis V1 named constants.
 *
 * Each value is either a sensible local-development default or a UI/log warning
 * threshold. None of these are commercial product gates. Self-hosted operators
 * may override every one of these via environment variables.
 *
 * Source of truth: docs/V1-SPEC.md §4.
 */
export const CONSTANTS = {
  // ────────────────────────────────────────────────────────────
  // Engine
  // ────────────────────────────────────────────────────────────

  WORKFLOW_COMPLEXITY_WARNING_TASKS: 100,
  // Above 100 tasks, show a UI warning recommending subflows. Never reject.

  WORKFLOW_PARALLELISM_DEFAULT: 'auto' as 'auto' | 'unbounded' | number,
  // 'auto' = min(readyTasks, onlineAgents, cpuCount * 2).

  RUN_STATE_SNAPSHOT_INTERVAL_EVENTS: 50,
  // Compact run-state snapshot cadence; bounds recovery replay cost.

  MAX_REPLAN_ATTEMPTS_DEFAULT: 3,

  // ────────────────────────────────────────────────────────────
  // Timeouts
  // ────────────────────────────────────────────────────────────

  PLANNING_LLM_TIMEOUT_MS: 60_000,
  AGENT_TASK_RESPONSE_TIMEOUT_MS: 300_000,
  AGENT_TASK_MAX_TURNS_DEFAULT: 24,
  ADAPTER_HEALTH_CHECK_INTERVAL_MS: 15_000,
  AGENT_HEARTBEAT_INTERVAL_MS: 15_000,

  // ────────────────────────────────────────────────────────────
  // Scratchpad (warnings, not hard caps)
  // ────────────────────────────────────────────────────────────

  SCRATCHPAD_SIZE_WARNING_BYTES: 10_485_760, // 10 MiB
  SCRATCHPAD_WRITE_CHUNK_SIZE: 10,

  // ────────────────────────────────────────────────────────────
  // Ledger
  // ────────────────────────────────────────────────────────────

  LEDGER_PAGE_SIZE: 100,

  // ────────────────────────────────────────────────────────────
  // Dashboard surfaces
  // ────────────────────────────────────────────────────────────

  ACTIVITY_FEED_PAGE_SIZE: 50,
  RUN_HISTORY_PAGE_SIZE: 50,
  COMMAND_PALETTE_RESULT_LIMIT: 12,
  FLEET_OVERVIEW_REFRESH_MS: 5_000,
  GATEWAY_RECONNECT_BACKOFF_MS: 2_000,
  GATEWAY_RECONNECT_MAX_BACKOFF_MS: 30_000,
  APPROVAL_INBOX_POLL_MS: 10_000,

  // ────────────────────────────────────────────────────────────
  // Webhooks
  // ────────────────────────────────────────────────────────────

  WEBHOOK_TIMESTAMP_TOLERANCE_MS: 300_000, // 5 min HMAC replay window
  WEBHOOK_MAX_RETRY_ATTEMPTS: 5,

  // ────────────────────────────────────────────────────────────
  // extension registry
  // ────────────────────────────────────────────────────────────

  EXTENSION_REGISTRY_TIMEOUT_MS: 10_000,
  EXTENSION_REGISTRY_RETRY_COUNT: 2,
  EXTENSION_REGISTRY_CACHE_TTL_SECONDS: 300,

  // ────────────────────────────────────────────────────────────
  // Extension runtime — three-tier trust model (V1-SPEC §9.2)
  // ────────────────────────────────────────────────────────────

  EXTENSION_EXECUTION_TIMEOUT_MS: 30_000,
  // Ceiling for a single extension execution. Raised to 15 min so the trusted
  // `store_factory_*` builtins that shell out to real host work (two sequential
  // Next.js production builds + live validation in `store_factory_deploy`) are
  // not clamped mid-build. Sandbox (node_worker/docker) extensions remain bounded
  // by their own per-manifest timeout, which callers rarely raise this high.
  EXTENSION_EXECUTION_MAX_TIMEOUT_MS: 900_000,

  EXTENSION_ISOLATE_HEAP_MB: 128,
  EXTENSION_ISOLATE_POOL_DEFAULT: 'auto' as 'auto' | number,

  EXTENSION_DOCKER_MEMORY_MB: 256,
  EXTENSION_DOCKER_CPU_QUOTA: 0.5,
  EXTENSION_DOCKER_TMP_MAX_MB: 64,
  EXTENSION_DOCKER_POOL_SIZE: 2,
  EXTENSION_DOCKER_WARM_LATENCY_TARGET_MS: 200,
  EXTENSION_DOCKER_COLD_START_TIMEOUT_MS: 10_000,

  // ────────────────────────────────────────────────────────────
  // Conversation layer
  // ────────────────────────────────────────────────────────────

  CONVERSATION_MESSAGE_MAX_LENGTH: 32_000,
  CONVERSATION_HISTORY_PAGE_SIZE: 50,
  CONVERSATION_AGENT_RESPONSE_TIMEOUT_MS: 120_000,
  CONVERSATION_SESSION_STALE_AFTER_MS: 30_000,
  CONVERSATION_SYNC_BATCH_SIZE: 100,

  // ────────────────────────────────────────────────────────────
  // Auth
  // ────────────────────────────────────────────────────────────

  BCRYPT_COST: 12,
  PASSWORD_MIN_LENGTH: 12,
  PASSWORD_MAX_LENGTH: 128,
  JWT_ACCESS_TOKEN_EXPIRY_SECONDS: 86_400, // 24h
  JWT_REFRESH_TOKEN_EXPIRY_SECONDS: 2_592_000, // 30d

  // ────────────────────────────────────────────────────────────
  // Living UI
  // ────────────────────────────────────────────────────────────

  PRESENCE_EVENT_TTL_MS: 5_000,
  PRESENCE_EVENT_THROTTLE_MS: 50,
  PRESENCE_BATCH_WINDOW_MS: 16,
  PRESENCE_MAX_AGENTS_VISIBLE: 8,
  FLIP_ANIMATION_DURATION_MS: 350,
  TYPEWRITER_CHAR_DELAY_MS: 28,
  LIVE_ACTIVITY_MAX_ENTRIES: 7,
  AGENT_COLOR_PALETTE: [
    '#6366f1',
    '#f59e0b',
    '#10b981',
    '#ef4444',
    '#8b5cf6',
    '#06b6d4',
    '#f97316',
    '#84cc16',
  ] as const,

  // ────────────────────────────────────────────────────────────
  // Runtime defaults
  // ────────────────────────────────────────────────────────────

  DEFAULT_HTTP_PORT: 3737,
  DEFAULT_DATA_DIR: '.agentis',

  // ────────────────────────────────────────────────────────────
  // Abilities — docs/brain/ABILITIES.md §7.3 + §3
  // ────────────────────────────────────────────────────────────

  ABILITY_COMPACT_MODE: true,
  /** Default total tokens across all injected abilities. Per-ability + per-workspace overrides apply. */
  ABILITY_TOKEN_BUDGET: 3_000,
  /** Minimum budget to bother injecting an ability — skip when remaining budget falls below. */
  MIN_ABILITY_TOKENS: 300,
  /** Cosine threshold for semantic pool injection. Below this, the ability is skipped entirely. */
  ABILITY_MIN_RELEVANCE_SCORE: 0.35,
  /** Per-ability max examples retrieved at dispatch. */
  ABILITY_MAX_EXAMPLES: 3,
  /** Per-ability max knowledge chunks retrieved at dispatch. */
  ABILITY_MAX_KNOWLEDGE: 5,
  /** Cap on abilities injected in a single dispatch (defense-in-depth above token budget). */
  ABILITY_MAX_INJECTED: 4,
  /** Synthetic-example importance threshold during compile §4 step 3. */
  ABILITY_SYNTHETIC_IMPORTANCE_THRESHOLD: 0.6,

  // ────────────────────────────────────────────────────────────
  // Agent sessions — docs/SMARTER-AGENTS-10X.md §VI–IX
  // ────────────────────────────────────────────────────────────

  /** Hard cap on cognitive steps a single session takes before forced completion. */
  SESSION_MAX_STEPS: 40,
  /** Token budget for a session's context window; compaction fires past the threshold. */
  SESSION_CONTEXT_TOKEN_BUDGET: 24_000,
  /** Fraction of the budget that triggers auto-compaction (0–1). */
  SESSION_COMPACTION_THRESHOLD: 0.7,
  /** Fraction of in-context messages evicted per compaction pass. */
  SESSION_COMPACTION_EVICT_FRACTION: 0.4,
  /** Max nested delegation depth — a session may delegate, but not infinitely. */
  SESSION_MAX_DELEGATION_DEPTH: 4,
  /** Cap on retained messages per run-scoped agent channel. */
  CHANNEL_MAX_MESSAGES: 200,
} as const;

export type AgentColor = (typeof CONSTANTS.AGENT_COLOR_PALETTE)[number];
