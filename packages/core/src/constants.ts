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
  // Skill registry
  // ────────────────────────────────────────────────────────────

  SKILL_REGISTRY_TIMEOUT_MS: 10_000,
  SKILL_REGISTRY_RETRY_COUNT: 2,
  SKILL_REGISTRY_CACHE_TTL_SECONDS: 300,

  // ────────────────────────────────────────────────────────────
  // Skill runtime — three-tier trust model (V1-SPEC §9.2)
  // ────────────────────────────────────────────────────────────

  SKILL_EXECUTION_TIMEOUT_MS: 30_000,
  SKILL_EXECUTION_MAX_TIMEOUT_MS: 300_000,

  SKILL_ISOLATE_HEAP_MB: 128,
  SKILL_ISOLATE_POOL_DEFAULT: 'auto' as 'auto' | number,

  SKILL_DOCKER_MEMORY_MB: 256,
  SKILL_DOCKER_CPU_QUOTA: 0.5,
  SKILL_DOCKER_TMP_MAX_MB: 64,
  SKILL_DOCKER_POOL_SIZE: 2,
  SKILL_DOCKER_WARM_LATENCY_TARGET_MS: 200,
  SKILL_DOCKER_COLD_START_TIMEOUT_MS: 10_000,

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
} as const;

export type AgentColor = (typeof CONSTANTS.AGENT_COLOR_PALETTE)[number];
