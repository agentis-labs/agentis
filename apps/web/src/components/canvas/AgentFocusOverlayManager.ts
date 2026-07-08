/**
 * AgentFocusOverlayManager — V1-SPEC §13.5.
 *
 * A presence-driven overlay layer for the workflow canvas. When agents
 * publish presence events (`agent.focused_on_node`, `agent.task_started`,
 * etc.), this manager moves a coloured halo on top of the workflow node the
 * agent is currently working on, then fades it out when the agent moves on.
 *
 * Why direct DOM mutation? React reconciliation cannot keep up with 20Hz
 * presence batches without dropped frames or stutter. We mutate
 * `style.transform` and `style.opacity` on a single overlay <div> per agent,
 * driven by a requestAnimationFrame loop, throttled to one paint per
 * PRESENCE_EVENT_THROTTLE_MS (50ms / 20Hz).
 *
 * The React component is a thin wrapper; the manager owns the DOM nodes and
 * the rAF loop directly. Components register the workflow nodes with
 * `registerNodeRect(nodeId, getRect)` and emit presence with `setAgentFocus`.
 */

import { CONSTANTS } from '@agentis/core';

export interface AgentPresence {
  agentId: string;
  nodeId: string | null;
  colorHex: string;
  intent?: 'thinking' | 'tool_call' | 'awaiting' | 'idle';
}

type RectGetter = () => { x: number; y: number; w: number; h: number } | null;

export class AgentFocusOverlayManager {
  private container: HTMLElement | null = null;
  private overlays = new Map<string, HTMLDivElement>();
  private nodeRects = new Map<string, RectGetter>();
  private presence = new Map<string, AgentPresence>();
  private raf = 0;
  private lastPaintAt = 0;
  private dirty = false;

  attach(container: HTMLElement): void {
    this.container = container;
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  detach(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const el of this.overlays.values()) el.remove();
    this.overlays.clear();
    this.container = null;
  }

  registerNodeRect(nodeId: string, getRect: RectGetter): () => void {
    this.nodeRects.set(nodeId, getRect);
    this.dirty = true;
    return () => {
      this.nodeRects.delete(nodeId);
    };
  }

  setAgentFocus(p: AgentPresence): void {
    this.presence.set(p.agentId, p);
    this.dirty = true;
  }

  clearAgent(agentId: string): void {
    this.presence.delete(agentId);
    const el = this.overlays.get(agentId);
    if (el) {
      el.style.opacity = '0';
      window.setTimeout(() => {
        el.remove();
        this.overlays.delete(agentId);
      }, CONSTANTS.FLIP_ANIMATION_DURATION_MS);
    }
  }

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.dirty) return;
    if (now - this.lastPaintAt < CONSTANTS.PRESENCE_EVENT_THROTTLE_MS) return;
    this.lastPaintAt = now;
    this.dirty = false;
    this.paint();
  };

  private paint(): void {
    if (!this.container) return;
    for (const [agentId, p] of this.presence.entries()) {
      let el = this.overlays.get(agentId);
      if (!el) {
        el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.pointerEvents = 'none';
        el.style.borderRadius = '14px';
        el.style.transition = `opacity ${CONSTANTS.FLIP_ANIMATION_DURATION_MS}ms ease, transform ${CONSTANTS.PRESENCE_EVENT_THROTTLE_MS * 2}ms ease`;
        el.style.willChange = 'transform, opacity';
        el.dataset['agentOverlay'] = agentId;
        this.container.appendChild(el);
        this.overlays.set(agentId, el);
      }
      const rectGetter = p.nodeId ? this.nodeRects.get(p.nodeId) : null;
      const rect = rectGetter ? rectGetter() : null;
      if (!rect) {
        el.style.opacity = '0';
        continue;
      }
      el.style.transform = `translate(${rect.x - 6}px, ${rect.y - 6}px)`;
      el.style.width = `${rect.w + 12}px`;
      el.style.height = `${rect.h + 12}px`;
      el.style.boxShadow = `0 0 0 2px ${p.colorHex}, 0 0 24px ${p.colorHex}66`;
      el.style.opacity = p.intent === 'awaiting' ? '0.4' : '0.85';
    }
  }
}



