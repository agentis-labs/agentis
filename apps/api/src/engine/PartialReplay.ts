/**
 * PartialReplay — V1-SPEC §3.3 spec-named entry point.
 *
 * Re-export of the canonical implementation in
 * `services/partialReplay.ts`. The spec lists this module under
 * `engine/` so it lives next to the workflow engine for discoverability;
 * the implementation is a service because it composes ledger reads with
 * engine re-dispatch.
 */

export { PartialReplayService } from '../services/partialReplay.js';
export type { ReplayArgs, ReplayMode } from '../services/partialReplay.js';
