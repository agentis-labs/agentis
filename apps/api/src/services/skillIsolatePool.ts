/**
 * SkillIsolatePool — V1-SPEC §3.3 spec-named module.
 *
 * Re-export of the canonical Node-worker / isolated-vm runtime in
 * `skills/nodeWorkerRuntime.ts`. The spec lists this file under
 * `services/` to underline that the isolate pool is a process-level
 * resource (warm pool, eviction, memory caps); the implementation lives
 * next to its sibling docker pool for organisational reasons.
 */

export {
  isNodeWorkerAvailable as isSkillIsolatePoolAvailable,
  runNodeWorkerSkill as runSkillInIsolate,
} from '../skills/nodeWorkerRuntime.js';
