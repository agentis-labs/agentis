/**
 * Skill manifest contract — V1-SPEC §9.
 *
 * The runtime field encodes the trust tier:
 *   - builtin       : in-process, ships with Agentis core, fully trusted.
 *   - node_worker   : isolated-vm V8 isolate; operator-installed local skills.
 *   - docker_sandbox: Docker container; auto-assigned to all Hub-installed
 *                     skills. Cannot be downgraded by the operator.
 */
export type SkillRuntime = 'builtin' | 'node_worker' | 'docker_sandbox';

export interface SkillManifest {
  name: string;
  slug: string;
  version: string;
  runtime: SkillRuntime;
  /**
   * For builtin: the in-repo executor key (resolved by the SkillRuntime registry).
   * For node_worker: relative path to the entry .js file inside the bundle.
   * For docker_sandbox: relative path inside the container's working dir.
   */
  entrypoint: string;
  capabilityTags: string[];
  /** JSON Schema; validated at execution boundary. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema; validated against the executor's return value. */
  outputSchema: Record<string, unknown>;
  /** Optional override; clamped to SKILL_EXECUTION_MAX_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Required for node_worker and docker_sandbox; absent for builtin. */
  allowedDomains?: string[];
  /** node_worker only: inline JavaScript module source. Must export `main(input, scratchpad)`. */
  source?: string;
  /** docker_sandbox only: absolute path to the unpacked skill bundle that will be mounted read-only. */
  bundleDir?: string;
}

export interface SkillExecutionRequest {
  skillId: string;
  manifest: SkillManifest;
  input: Record<string, unknown>;
  /** Subset of scratchpad explicitly declared in inputMapping. */
  scratchpadSnapshot: Record<string, unknown>;
  runId?: string;
  taskId?: string;
}

export interface SkillExecutionResult {
  ok: true;
  output: Record<string, unknown>;
  durationMs: number;
}

export interface SkillExecutionFailure {
  ok: false;
  errorCode:
    | 'SKILL_TIMEOUT'
    | 'SKILL_NETWORK_VIOLATION'
    | 'SKILL_DOCKER_UNAVAILABLE'
    | 'SKILL_RUNTIME_UNAVAILABLE'
    | 'SKILL_SSRF_BLOCKED'
    | 'SKILL_INPUT_INVALID'
    | 'SKILL_OUTPUT_INVALID'
    | 'SKILL_INTERNAL'
    | 'VALIDATION_FAILED';
  message: string;
  durationMs: number;
}

export type SkillExecutionOutcome = SkillExecutionResult | SkillExecutionFailure;
