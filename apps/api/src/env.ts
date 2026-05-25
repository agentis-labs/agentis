import { z } from 'zod';
import { CONSTANTS } from '@agentis/core';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  AGENTIS_MODE: z.enum(['embedded', 'standard']).optional(),
  AGENTIS_DATA_DIR: z.string().default(CONSTANTS.DEFAULT_DATA_DIR),
  AGENTIS_HTTP_PORT: z.coerce.number().int().positive().default(CONSTANTS.DEFAULT_HTTP_PORT),
  AGENTIS_HTTP_HOST: z.string().default('127.0.0.1'),

  // Standard mode
  AGENTIS_DATABASE_URL: z.string().optional(),
  AGENTIS_REDIS_URL: z.string().optional(),

  // Auth seed (only used on first boot when no users exist)
  AGENTIS_SEED_USERNAME: z.string().default('operator'),
  AGENTIS_SEED_PASSWORD: z.string().optional(),
  AGENTIS_SEED_DISPLAY_NAME: z.string().default('Operator'),

  // Generated secrets are written to AGENTIS_DATA_DIR/secrets.json on first
  // boot and read from there on subsequent boots. Setting these env vars
  // overrides the file.
  AGENTIS_JWT_PRIVATE_KEY: z.string().optional(),
  AGENTIS_JWT_PUBLIC_KEY: z.string().optional(),
  AGENTIS_CREDENTIAL_KEY: z.string().optional(),

  // Skill runtime
  AGENTIS_SKILL_DOCKER: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  AGENTIS_SKILL_DOCKER_POOL_SIZE: z.coerce.number().int().positive().optional(),

  // Engine
  AGENTIS_WORKFLOW_PARALLELISM: z.string().default('auto'),

  // Skill registry client — defaults to the public ClawdHub registry.
  // Operators can point at a self-hosted mirror by setting
  // AGENTIS_SKILL_REGISTRY_URL.
  AGENTIS_SKILL_REGISTRY_URL: z.string().url().default('https://clawhub.ai/api'),
  AGENTIS_SKILL_REGISTRY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Dashboard static asset serving (V1-SPEC §13). When set, the API server
  // serves the built dashboard from this directory at any non-/v1 path.
  AGENTIS_DASHBOARD_DIST: z.string().optional(),

  // E2E test harness. When `true`, the API mounts `/v1/_test/reset` (drops
  // every row + re-runs the seed) and forces a deterministic seed password
  // if one is not explicitly provided. Never enable in production — the
  // reset endpoint is unauthenticated by design so Playwright can use it
  // before logging in.
  AGENTIS_TEST_MODE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // OpenTelemetry — opt-in via OTLP/HTTP endpoint (e.g.
  // `http://localhost:4318/v1/traces`). When unset the engine + adapters
  // run with a no-op tracer. The OTel SDK packages are loaded dynamically
  // so an install that doesn't need tracing keeps the dep graph small.
  AGENTIS_OTEL_ENDPOINT: z.string().url().optional(),
  AGENTIS_OTEL_SERVICE_NAME: z.string().default('agentis-api'),

  // Evaluator runtime — opt-in. When unset, `evaluator` nodes fail at dispatch
  // with WORKFLOW_GRAPH_INVALID and `router` llm_route mode falls back to
  // first-match. Configure to enable LLM-as-judge for quality gates.
  AGENTIS_EVALUATOR_BASE_URL: z.string().url().optional(),
  AGENTIS_EVALUATOR_API_KEY: z.string().optional(),
  AGENTIS_EVALUATOR_MODEL: z.string().optional(),

  // Workflow synthesis runtime (§6). Dedicated model for `build_workflow` LLM
  // synthesis so it is NOT gated behind the evaluator config. When unset, falls
  // back to the evaluator runtime; when neither is set, build_workflow uses the
  // deterministic regex/template path.
  WORKFLOW_SYNTHESIS_BASE_URL: z.string().url().optional(),
  WORKFLOW_SYNTHESIS_API_KEY: z.string().optional(),
  WORKFLOW_SYNTHESIS_MODEL: z.string().default('gpt-4o-mini'),

  // Orchestrator chat runtime — opt-in fast path for the operator-facing chat.
  // When set, interactive chat turns for agents whose runtime is a slow
  // marker-protocol CLI (Codex / Claude Code) are answered by this native
  // function-calling endpoint instead — token-streamed tool calls, no per-turn
  // process re-spawn — while still attributed to the selected agent. Falls back
  // to the evaluator endpoint when these are unset; when neither is configured,
  // chat uses the agent's own adapter exactly as before.
  AGENTIS_ORCHESTRATOR_BASE_URL: z.string().url().optional(),
  AGENTIS_ORCHESTRATOR_API_KEY: z.string().optional(),
  AGENTIS_ORCHESTRATOR_MODEL: z.string().optional(),

  // Inline OAuth (ORCHESTRATOR-CREATION §7). Public base URL the provider
  // redirects back to — must match the registered OAuth app redirect URI
  // (`<AGENTIS_PUBLIC_URL>/v1/oauth/<provider>/callback`). Defaults to the
  // local HTTP host:port. A provider's "Sign in with X" button only appears
  // when its client id + secret are configured.
  AGENTIS_PUBLIC_URL: z.string().url().optional(),
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OAUTH_SLACK_CLIENT_ID: z.string().optional(),
  OAUTH_SLACK_CLIENT_SECRET: z.string().optional(),
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
});

export type AgentisEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AgentisEnv {
  return envSchema.parse(source);
}
