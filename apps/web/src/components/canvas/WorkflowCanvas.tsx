/**
 * WorkflowCanvas — V1-SPEC §3.3 spec-named canvas wrapper.
 *
 * Re-exports the canvas-related primitives so callers can `import {
 * WorkflowCanvas, WorkflowNode, AgentNode }` from a single barrel. The
 * full canvas experience is implemented inline in `WorkflowCanvasPage`
 * because it owns react-flow state, dirty tracking, and the run-drawer
 * interplay; this module exposes the building blocks.
 */

export { WorkflowNode, NODE_GLYPH } from './WorkflowNode';
export type { WorkflowNodeData } from './WorkflowNode';
export { AgentNode } from './AgentNode';
export type { AgentNodeData } from './AgentNode';
export { NodePalette } from './NodePalette';
export { RunDrawer } from './RunDrawer';
export { CanvasEngine } from './CanvasEngine';
export type { CanvasEngineInstance } from './CanvasEngine';
