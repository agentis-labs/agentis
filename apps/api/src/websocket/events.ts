/**
 * V1-SPEC §3.3 spec-named event constants module.
 *
 * The canonical strings live in `@agentis/core` so adapters, the dashboard,
 * and the API server all agree on event names without duplication. This
 * file is the spec-named entry point that other modules can import from
 * `./websocket/events.js` per the documented file structure.
 */
export { REALTIME_EVENTS, REALTIME_ROOMS, type RealtimeEventName, type RealtimeEnvelope } from '@agentis/core';
