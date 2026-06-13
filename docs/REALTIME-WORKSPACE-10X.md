# Realtime Workspace Canvas & Monitor 10X Masterplan

## 1. Industry Research & UX Patterns (2025-2026)

Modern AI agent interfaces (like Devin, Claude Artifacts, Lovable, and Vercel v0) have moved past simple chat interfaces into **transparent, activity-based, and modular control surfaces**. The goal is to bridge the "intent-to-execution" gap. 

Key patterns include:
- **Separation of Concerns:** Decoupling the "chat thread" (intent/goals) from the "activity panel" (execution/thoughts).
- **Thinking & Reasoning Visibility:** Real-time observability of the agent's internal monologue (Thought-Action-Observation cycle) instead of generic loading spinners.
- **Generative UI & Live Rendering:** Artifacts and widgets that render in real-time, allowing users to see what is being built dynamically (e.g., streaming code, UI previews, dynamic graphs).
- **Control Surfaces (Human-in-the-loop):** Interactive approval buttons, explicit rollback hooks, and autonomy sliders directly within the stream.
- **Immersive Streaming:** Smooth typing indicators, token streaming, and visual tool-call execution that makes the AI feel "alive" rather than just a batch process.

## 2. 10X Home Page Workspace Canvas (`/home`)

Currently, the `WorkspaceEcosystemCanvas` renders a graph of agents, workflows, and spaces, and uses `useAgentLiveFeed` to gather realtime events. However, it lacks an immersive, visceral feeling of "work being done." 

**The 10X Vision:**
- **Dynamic Energy Flows:** The SVG edges between nodes shouldn't just glow; they should have rich, animated particle streams (data packets) flowing when an agent is actively processing or communicating with another agent.
- **Live "Thought" Bubbles & Terminal Streams:** Instead of just a generic `CanvasActivityPopover` on hover, active agents should display an integrated, holographic "thought stream" or mini-terminal adjacent to their node. When an agent is executing (`AGENT_WORK_STEP` / `AGENT_TERMINAL_TOOL_CALL`), the canvas should show a beautifully styled, scrolling ticker of their internal logs and tool usages.
- **State Changes & Pulses:** When an agent finishes a task, a ripple effect should emanate from the node across the canvas. When an agent hits an error, the node should visually glitch or pulse red, drawing immediate attention.
- **Zoom-Dependent Detail:** 
  - *Zoomed out:* Heatmaps of activity, glowing nodes, and particle flows.
  - *Zoomed in:* Full streaming logs, live code diffs, and exact tool invocation arguments shown directly on the canvas node.

## 3. Workflow Canvas Monitor Card

On the `WorkflowCanvasPage`, users need a way to monitor execution without losing the context of the workflow they are building.

**The 10X Vision:**
- **Integrated HUD Monitor:** Replace or upgrade the floating `MiniMonitorWidget` into a sleek, glassmorphic "Monitor Card" embedded in the workflow canvas UI (e.g., top-right or bottom-right).
- **Collapsible & Resizable:** It should default to a minimized pill (showing just status, active node, and time) but can expand into a full "Mission Control" card.
- **Live Execution Tracking:** 
  - As the workflow runs, the monitor card streams `NODE_STARTED`, `NODE_COMPLETED`, and agent thoughts in a beautiful terminal-like feed.
  - It syncs with the canvas: clicking an event in the monitor card pans the workflow canvas directly to the executing node.
- **Human-in-the-loop (HITL) Inline:** When an `APPROVAL_REQUESTED` event fires, the monitor card turns amber, pulses, and presents the approval context inline (Approve/Reject) without needing to open a separate modal.

## 4. Agentis Realtime Infrastructure Integration

Agentis already has the robust backend infrastructure to support this via `EventBus` and `REALTIME_EVENTS`.

- **Event Sources to Leverage:**
  - `AGENT_TERMINAL_MESSAGE`, `AGENT_TERMINAL_TOOL_CALL`, `AGENT_WORK_STEP` for the live thought streams.
  - `NODE_STARTED`, `NODE_COMPLETED`, `NODE_FAILED` for workflow canvas highlights.
  - `RUN_RUNNING`, `RUN_COMPLETED`, `RUN_FAILED` for high-level status.
- **Frontend Upgrades:**
  - Enhance `useAgentLiveFeed.ts` to retain a deeper history of terminal messages per agent, allowing the UI to render smooth scrolling logs.
  - Create a new `CanvasAgentLiveStream.tsx` component to attach to nodes in the `WorkspaceEcosystemCanvas`.
  - Build `WorkflowMonitorCard.tsx` (a heavily upgraded version of `MiniMonitorWidget`) that hooks into `useRealtime` and ties directly into the React Flow instance for panning and node highlighting.
- **Performance Considerations:**
  - Use `requestAnimationFrame` for edge particle animations to prevent React render cycles from bogging down the canvas.
  - Throttle text streaming updates in the thought bubbles so that the DOM isn't overwhelmed by high-speed token generation.

---
**Next Steps:**
1. Review and refine this plan.
2. Implement the `WorkflowMonitorCard` on the workflow canvas.
3. Upgrade the `WorkspaceEcosystemCanvas` node components to feature live thought streams and enhanced energy flows.
