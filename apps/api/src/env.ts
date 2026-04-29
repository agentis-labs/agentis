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
});

export type AgentisEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AgentisEnv {
  return envSchema.parse(source);
}
