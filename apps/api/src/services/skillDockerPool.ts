/**
 * SkillDockerPool — V1-SPEC §3.3 spec-named module.
 *
 * Re-export of the canonical Docker-sandbox runtime in
 * `skills/dockerSandboxRuntime.ts`. See `skillIsolatePool.ts` for the
 * sibling node-worker pool.
 */

export {
  isDockerSandboxAvailable as isSkillDockerPoolAvailable,
  runDockerSandboxSkill as runSkillInDocker,
} from '../skills/dockerSandboxRuntime.js';
