/**
 * BrainStage — the living Map view of the intelligence topology.
 *
 * A bespoke <canvas> renderer driven by a continuously running d3-force
 * simulation. Built for scale: idle graphs cost zero CPU (the render loop
 * skips frames when nothing is moving), glow is drawn from cached sprites,
 * and labels are placed with greedy collision avoidance so a dense graph
 * stays legible instead of turning into a wall of overlapping text.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import type { BrainEdge, BrainGraph, BrainNode, BrainResponse } from '@agentis/core';
import type { BrainVisibleLayers } from './LayerFilterChips';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { graphToBrainEdges, graphToBrainNodes } from './brainGraphAdapter';

interface StageProps {
  brain: BrainResponse;
  graph?: BrainGraph | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  filters: {
    showWarnings: boolean;
    showGaps: boolean;
    visibleLayers: BrainVisibleLayers;
  };
  livePulse?: number;
  /** Scope key for the simulation. Changing it resets the layout. */
  layoutKey?: string;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  node: BrainNode;
  degree: number;
  baseRadius: number;
  /** Eased render radius — lerps toward the interaction target each frame. */
  radius: number;
  color: string;
  isCore: boolean;
  x: number;
  y: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
  edge: BrainEdge;
}

interface Transform {
  x: number;
  y: number;
  k: number;
}

interface Tween {
  from: Transform;
  to: Transform;
  start: number;
  dur: number;
}

const MIN_ZOOM = 0.06;
const MAX_ZOOM = 6;

export function BrainStage({ brain, graph, selectedId, onSelect, filters, livePulse = 0, layoutKey }: StageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // ---- data --------------------------------------------------------------
  const allNodes = useMemo<BrainNode[]>(
    () => (graph && graph.nodes.length > 1
      ? graphToBrainNodes(graph)
      : [
          ...brain.layers.core,
          ...brain.layers.knowledge,
          ...brain.layers.memory,
          ...brain.layers.judgment,
        ]),
    [brain.layers, graph],
  );

  const allEdges = useMemo<BrainEdge[]>(
    () => (graph && graph.links.length > 0 ? graphToBrainEdges(graph) : brain.edges),
    [brain.edges, graph],
  );

  const visibleNodeIds = useMemo(() => {
    const out = new Set<string>();
    for (const node of allNodes) {
      if (node.layer === 'core') { out.add(node.id); continue; }
      if (!filters.visibleLayers[node.layer]) continue;
      if (node.type === 'warning' && !filters.showWarnings) continue;
      if (node.type === 'gap' && !filters.showGaps) continue;
      out.add(node.id);
    }
    return out;
  }, [allNodes, filters]);

  const visibleNodes = useMemo(
    () => allNodes.filter((n) => visibleNodeIds.has(n.id)),
    [allNodes, visibleNodeIds],
  );
  const visibleEdges = useMemo(
    () => allEdges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)),
    [allEdges, visibleNodeIds],
  );

  // ---- mutable render state (refs — never trigger React re-renders) ------
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodeMapRef = useRef<Map<string, SimNode>>(new Map());
  const linksRef = useRef<SimLink[]>([]);
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const tweenRef = useRef<Tween | null>(null);
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(selectedId);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const needFitRef = useRef(false);
  const dirtyRef = useRef(true);
  const layoutKeyRef = useRef<string | undefined>(layoutKey);
  const dragRef = useRef<{ node: SimNode; moved: boolean } | null>(null);
  const panRef = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);
  const onSelectRef = useRef(onSelect);

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { selectedRef.current = selectedId; dirtyRef.current = true; }, [selectedId]);

  const toWorld = useCallback((sx: number, sy: number) => {
    const t = transformRef.current;
    return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
  }, []);

  const fitView = useCallback((animate = true) => {
    const nodes = [...nodeMapRef.current.values()];
    const { w, h } = sizeRef.current;
    if (nodes.length === 0 || w === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.baseRadius);
      minY = Math.min(minY, n.y - n.baseRadius);
      maxX = Math.max(maxX, n.x + n.baseRadius);
      maxY = Math.max(maxY, n.y + n.baseRadius);
    }
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w - 160) / bw, (h - 160) / bh, 1.6)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const to: Transform = { k, x: w / 2 - cx * k, y: h / 2 - cy * k };
    if (animate) {
      tweenRef.current = { from: { ...transformRef.current }, to, start: performance.now(), dur: 480 };
    } else {
      transformRef.current = to;
    }
    dirtyRef.current = true;
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const t = transformRef.current;
    const { w, h } = sizeRef.current;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k * factor));
    const wx = (w / 2 - t.x) / t.k;
    const wy = (h / 2 - t.y) / t.k;
    const to: Transform = { k, x: w / 2 - wx * k, y: h / 2 - wy * k };
    tweenRef.current = { from: { ...t }, to, start: performance.now(), dur: 220 };
    dirtyRef.current = true;
  }, []);

  const hitTest = useCallback((sx: number, sy: number): SimNode | null => {
    const t = transformRef.current;
    let best: SimNode | null = null;
    for (const n of nodeMapRef.current.values()) {
      const dx = sx - (n.x * t.k + t.x);
      const dy = sy - (n.y * t.k + t.y);
      const r = n.radius * t.k + 6;
      if (dx * dx + dy * dy <= r * r) best = n;
    }
    return best;
  }, []);

  // ---- reconcile simulation with the visible data ------------------------
  useEffect(() => {
    const keyChanged = layoutKeyRef.current !== layoutKey;
    layoutKeyRef.current = layoutKey;
    if (keyChanged) {
      nodeMapRef.current = new Map();
      simRef.current?.stop();
      simRef.current = null;
    }
    const reuse = nodeMapRef.current;

    const degree = new Map<string, number>();
    for (const e of visibleEdges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    const nextMap = new Map<string, SimNode>();
    for (const node of visibleNodes) {
      const d = degree.get(node.id) ?? 0;
      const isCore = node.layer === 'core';
      const baseRadius = isCore
        ? 22
        : Math.max(5, Math.min(24, 4 + Math.sqrt(d) * 3.4 + (node.weight ?? 0.4) * 7));
      const color = dotColor(node);
      const existing = reuse.get(node.id);
      if (existing) {
        existing.node = node;
        existing.degree = d;
        existing.baseRadius = baseRadius;
        existing.color = color;
        existing.isCore = isCore;
        nextMap.set(node.id, existing);
      } else {
        const seedX = isCore ? 0 : node.x ?? (Math.random() - 0.5) * 320;
        const seedY = isCore ? 0 : node.y ?? (Math.random() - 0.5) * 320;
        const sn: SimNode = {
          id: node.id, node, degree: d, baseRadius, radius: baseRadius,
          color, isCore, x: seedX, y: seedY,
        };
        if (isCore) { sn.fx = 0; sn.fy = 0; }
        nextMap.set(node.id, sn);
      }
    }
    nodeMapRef.current = nextMap;

    const simNodes = [...nextMap.values()];
    const simLinks: SimLink[] = visibleEdges
      .filter((e) => nextMap.has(e.source) && nextMap.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, edge: e }));
    linksRef.current = simLinks;
    dirtyRef.current = true;

    let sim = simRef.current;
    if (!sim) {
      sim = forceSimulation<SimNode, SimLink>(simNodes)
        .force('charge', forceManyBody<SimNode>()
          .strength((n) => (n.isCore ? -560 : -150 - n.degree * 26))
          .distanceMax(840))
        .force('link', forceLink<SimNode, SimLink>(simLinks)
          .id((n) => n.id)
          .distance((l) => linkDistance(l.source as SimNode, l.target as SimNode))
          .strength((l) => 0.08 + (l.edge.weight ?? 0.4) * 0.32))
        .force('x', forceX<SimNode>(0).strength(0.055))
        .force('y', forceY<SimNode>(0).strength(0.055))
        .force('collide', forceCollide<SimNode>().radius((n) => n.baseRadius + 7).strength(0.86).iterations(2))
        .velocityDecay(0.42)
        .alphaDecay(0.021)
        .alphaMin(0.0016)
        .stop();
      simRef.current = sim;
      // Warm fewer ticks on large graphs — they finish settling live, which
      // also gives a pleasant "bloom" animation instead of a blocking freeze.
      const warm = simNodes.length > 180 ? 70 : 130;
      for (let i = 0; i < warm; i += 1) sim.tick();
      needFitRef.current = true;
    } else {
      sim.nodes(simNodes);
      (sim.force('link') as ForceLink<SimNode, SimLink>).links(simLinks);
      sim.alpha(Math.max(sim.alpha(), 0.5));
    }
  }, [visibleNodes, visibleEdges, layoutKey]);

  // ---- canvas lifecycle --------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const applySize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      dirtyRef.current = true;
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(container);

    let raf = 0;
    const frame = (time: number) => {
      const sim = simRef.current;
      const ticked = Boolean(sim && sim.alpha() > sim.alphaMin());
      if (ticked) sim!.tick();

      const tw = tweenRef.current;
      if (tw) {
        const p = Math.min(1, (time - tw.start) / tw.dur);
        const e = 1 - Math.pow(1 - p, 3);
        transformRef.current = {
          x: tw.from.x + (tw.to.x - tw.from.x) * e,
          y: tw.from.y + (tw.to.y - tw.from.y) * e,
          k: tw.from.k + (tw.to.k - tw.from.k) * e,
        };
        if (p >= 1) tweenRef.current = null;
      }
      if (needFitRef.current && sizeRef.current.w > 0) {
        needFitRef.current = false;
        fitView(false);
      }
      // Idle graphs cost nothing: only paint when something actually moved.
      // A hovered node keeps the loop warm so its flow pulses animate.
      const animating = ticked || Boolean(tw) || Boolean(hoverRef.current) || dragRef.current !== null;
      if (animating || dirtyRef.current) {
        draw(ctx, time);
        dirtyRef.current = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      const t = transformRef.current;
      const factor = Math.exp(-ev.deltaY * 0.0014);
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k * factor));
      const wx = (sx - t.x) / t.k;
      const wy = (sy - t.y) / t.k;
      tweenRef.current = null;
      transformRef.current = { k, x: sx - wx * k, y: sy - wy * k };
      dirtyRef.current = true;
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the draw routine --------------------------------------------------
  const draw = useCallback((ctx: CanvasRenderingContext2D, time: number) => {
    const { w, h, dpr } = sizeRef.current;
    if (w === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const t = transformRef.current;
    const map = nodeMapRef.current;

    const focus = hoverRef.current ?? selectedRef.current;
    let neighbourhood: Set<string> | null = null;
    if (focus && map.has(focus)) {
      neighbourhood = new Set([focus]);
      for (const l of linksRef.current) {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const tg = typeof l.target === 'object' ? l.target.id : l.target;
        if (s === focus) neighbourhood.add(tg);
        else if (tg === focus) neighbourhood.add(s);
      }
    }

    // ---- edges ----
    ctx.lineCap = 'round';
    for (const l of linksRef.current) {
      const s = typeof l.source === 'object' ? l.source : map.get(l.source);
      const tg = typeof l.target === 'object' ? l.target : map.get(l.target);
      if (!s || !tg) continue;
      const focused = !neighbourhood || (neighbourhood.has(s.id) && neighbourhood.has(tg.id));
      const weight = l.edge.weight ?? 0.45;
      const a = focused ? 0.12 + weight * 0.4 : 0.035;
      const sx = s.x * t.k + t.x;
      const sy = s.y * t.k + t.y;
      const tx = tg.x * t.k + t.x;
      const ty = tg.y * t.k + t.y;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = withAlpha(edgeStroke(l.edge), a);
      ctx.lineWidth = (0.5 + weight * 1.2) * Math.min(1.6, Math.max(0.5, t.k));
      const dash = edgeDash(l.edge);
      ctx.setLineDash(dash ?? []);
      ctx.stroke();
      ctx.setLineDash([]);

      if (focused && a > 0.16 && isFlowEdge(l.edge) && hoverRef.current) {
        const p = ((time / 1500) + hashUnit(l.edge.id)) % 1;
        const px = sx + (tx - sx) * p;
        const py = sy + (ty - sy) * p;
        const pr = 2 * Math.min(1.6, Math.max(0.7, t.k));
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(edgeStroke(l.edge), 0.85);
        ctx.shadowColor = edgeStroke(l.edge);
        ctx.shadowBlur = 7;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // ---- nodes ----
    const ordered = [...map.values()].sort((a, b) => rank(a, focus) - rank(b, focus));
    for (const n of ordered) {
      const isFocus = focus === n.id;
      const isNeighbour = Boolean(neighbourhood && neighbourhood.has(n.id));
      const isSelected = selectedRef.current === n.id;
      const isHover = hoverRef.current === n.id;
      const stateMul = isHover ? 1.3 : isSelected ? 1.2 : isNeighbour ? 1.06 : 1;
      n.radius += (n.baseRadius * stateMul - n.radius) * 0.22;

      const sx = n.x * t.k + t.x;
      const sy = n.y * t.k + t.y;
      const r = Math.max(1.5, n.radius * t.k);
      // viewport cull — skip anything well outside the visible area
      if (sx < -80 || sy < -80 || sx > w + 80 || sy > h + 80) continue;

      const dim = Boolean(neighbourhood && !isNeighbour && !isFocus);
      const conf = n.node.confidence ?? 0.5;
      ctx.globalAlpha = dim ? 0.12 : 1;

      // soft glow from a cached sprite (cheap, consistent)
      const glowStrength = (isHover || isSelected ? 0.7 : 0.26 + conf * 0.3);
      const glowSize = r * (isHover || isSelected ? 6.2 : 4.6);
      const sprite = glowSprite(n.color);
      ctx.globalAlpha = (dim ? 0.12 : 1) * glowStrength;
      ctx.drawImage(sprite, sx - glowSize / 2, sy - glowSize / 2, glowSize, glowSize);
      ctx.globalAlpha = dim ? 0.12 : 1;

      // spherical body — offset radial gradient gives depth instead of a flat disc
      const body = ctx.createRadialGradient(
        sx - r * 0.42, sy - r * 0.46, r * 0.12,
        sx, sy, r * 1.04,
      );
      body.addColorStop(0, lighten(n.color, 0.62));
      body.addColorStop(0.5, n.color);
      body.addColorStop(1, darken(n.color, 0.34));
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();

      // crisp rim
      ctx.beginPath();
      ctx.arc(sx, sy, r - 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(lighten(n.color, 0.5), 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();

      // specular highlight
      if (r > 3.5) {
        const spec = ctx.createRadialGradient(
          sx - r * 0.36, sy - r * 0.4, 0,
          sx - r * 0.36, sy - r * 0.4, r * 0.66,
        );
        spec.addColorStop(0, withAlpha('#ffffff', 0.55));
        spec.addColorStop(1, withAlpha('#ffffff', 0));
        ctx.beginPath();
        ctx.arc(sx - r * 0.34, sy - r * 0.38, r * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = spec;
        ctx.fill();
      }

      // orphan ring
      if (n.degree === 0 && !n.isCore) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3, 0, Math.PI * 2);
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = withAlpha('#94a3b8', 0.45);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // selection / hover ring
      if (isSelected || isHover) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)';
        ctx.lineWidth = isSelected ? 1.75 : 1.4;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ---- labels (greedy collision avoidance) ----
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '600 11px Inter, system-ui, -apple-system, sans-serif';
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const duplicateLabels = new Set<string>();
    const neighbourLabelBudget = 8;
    let neighbourLabels = 0;
    const labelOrder = [...ordered].sort((a, b) => labelImportance(b, focus) - labelImportance(a, focus));
    for (const n of labelOrder) {
      const isFocus = focus === n.id;
      const isNeighbour = Boolean(neighbourhood && neighbourhood.has(n.id));
      const sx = n.x * t.k + t.x;
      const sy = n.y * t.k + t.y;
      const r = n.radius * t.k;
      if (sx < -40 || sy < -40 || sx > w + 40 || sy > h + 40) continue;

      let eligible: boolean;
      if (neighbourhood) eligible = isFocus || isNeighbour;
      else if (n.isCore) eligible = true;
      else if (isFocus) eligible = true;
      else if (t.k > 1.25) eligible = true;
      else if (t.k > 0.6 && n.degree >= 3) eligible = true;
      else eligible = false;
      if (!eligible) continue;

      const text = shortLabel(n.node.label);
      const labelKey = text.toLocaleLowerCase();
      if (!isFocus && duplicateLabels.has(labelKey)) continue;
      if (neighbourhood && isNeighbour && !isFocus && !n.isCore && neighbourLabels >= neighbourLabelBudget) continue;

      const tw = ctx.measureText(text).width;
      const lx = sx;
      const ly = sy + r + 5;
      const rect = { x: lx - tw / 2 - 4, y: ly - 2, w: tw + 8, h: 15 };
      const mustShow = isFocus || (!neighbourhood && n.isCore);
      if (!mustShow) {
        let clash = false;
        for (const p of placed) {
          if (rect.x < p.x + p.w && rect.x + rect.w > p.x && rect.y < p.y + p.h && rect.y + rect.h > p.y) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
      }
      placed.push(rect);
      duplicateLabels.add(labelKey);
      if (neighbourhood && isNeighbour && !isFocus && !n.isCore) neighbourLabels += 1;

      const labelAlpha = mustShow ? 1 : 0.82;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = withAlpha('#0a0b0f', 0.9 * labelAlpha);
      ctx.strokeText(text, lx, ly);
      ctx.fillStyle = withAlpha('#e7ebf3', labelAlpha);
      ctx.fillText(text, lx, ly);
    }
  }, []);

  // ---- pointer interaction ----------------------------------------------
  const localPoint = (ev: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(ev);
    try { canvasRef.current?.setPointerCapture(ev.pointerId); } catch { /* non-active pointer */ }
    const hit = hitTest(x, y);
    const sim = simRef.current;
    if (hit) {
      dragRef.current = { node: hit, moved: false };
      if (sim) {
        sim.alphaTarget(0.32);
        sim.alpha(Math.max(sim.alpha(), 0.4));
      }
      hit.fx = hit.x;
      hit.fy = hit.y;
    } else {
      const t = transformRef.current;
      panRef.current = { px: x, py: y, ox: t.x, oy: t.y, moved: false };
    }
    dirtyRef.current = true;
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(ev);
    const canvas = canvasRef.current;
    dirtyRef.current = true;
    if (dragRef.current) {
      const wp = toWorld(x, y);
      const d = dragRef.current;
      d.node.fx = wp.x;
      d.node.fy = wp.y;
      d.moved = true;
      const sim = simRef.current;
      if (sim) sim.alpha(Math.max(sim.alpha(), 0.32));
      return;
    }
    if (panRef.current) {
      const p = panRef.current;
      const dx = x - p.px;
      const dy = y - p.py;
      if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true;
      tweenRef.current = null;
      transformRef.current = { ...transformRef.current, x: p.ox + dx, y: p.oy + dy };
      if (canvas) canvas.style.cursor = 'grabbing';
      return;
    }
    const hit = hitTest(x, y);
    hoverRef.current = hit ? hit.id : null;
    if (canvas) canvas.style.cursor = hit ? 'pointer' : 'grab';
  };

  const endInteraction = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    try { canvasRef.current?.releasePointerCapture(ev.pointerId); } catch { /* non-active pointer */ }
    const sim = simRef.current;
    if (dragRef.current) {
      const d = dragRef.current;
      if (sim) sim.alphaTarget(0);
      if (!d.node.isCore) { d.node.fx = null; d.node.fy = null; }
      if (!d.moved) {
        const id = d.node.id;
        onSelectRef.current(id === selectedRef.current ? null : id);
      }
      dragRef.current = null;
    } else if (panRef.current) {
      if (!panRef.current.moved) onSelectRef.current(null);
      panRef.current = null;
    }
    dirtyRef.current = true;
  };

  const onDoubleClick = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(ev);
    const hit = hitTest(x, y);
    const { w, h } = sizeRef.current;
    if (hit) {
      const k = Math.max(transformRef.current.k, 1.15);
      tweenRef.current = {
        from: { ...transformRef.current },
        to: { k, x: w / 2 - hit.x * k, y: h / 2 - hit.y * k },
        start: performance.now(), dur: 420,
      };
      dirtyRef.current = true;
    } else {
      fitView(true);
    }
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-bg-base">
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_center,rgba(124,131,255,0.1),transparent_62%)]" />
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_30%_75%,rgba(34,211,238,0.055),transparent_48%)]" />

      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-10 touch-none select-none"
        style={{ cursor: 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
        onPointerLeave={() => { hoverRef.current = null; dirtyRef.current = true; }}
        onDoubleClick={onDoubleClick}
      />

      {graph && (
        <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-md border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-cyan-200 backdrop-blur-sm">
          <span className={['mr-1 inline-block h-1.5 w-1.5 rounded-full bg-cyan-300', livePulse > 0 ? 'animate-pulse' : ''].join(' ')} />
          {graph.meta.atomCount} atoms · {graph.meta.linkCount} links
        </div>
      )}

      <div className="absolute bottom-3 right-3 z-20 flex flex-col gap-1">
        <ControlButton label="Zoom in" onClick={() => zoomBy(1.35)}><Plus size={14} /></ControlButton>
        <ControlButton label="Zoom out" onClick={() => zoomBy(1 / 1.35)}><Minus size={14} /></ControlButton>
        <ControlButton label="Fit to view" onClick={() => fitView(true)}><Maximize2 size={13} /></ControlButton>
      </div>

    </div>
  );
}

function ControlButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-btn border border-line bg-surface-2/90 text-text-secondary shadow-card backdrop-blur transition-colors hover:bg-surface hover:text-text-primary"
    >
      {children}
    </button>
  );
}

// ---- pure helpers --------------------------------------------------------

function rank(node: SimNode, focus: string | null): number {
  if (node.id === focus) return 3;
  if (node.isCore) return 2;
  return node.degree;
}

function labelImportance(node: SimNode, focus: string | null): number {
  if (node.id === focus) return 1_000_000;
  if (node.isCore) return 900_000;
  return node.degree * 100 + (node.node.weight ?? 0) * 20 + (node.node.confidence ?? 0) * 10;
}

function linkDistance(s: SimNode, t: SimNode): number {
  if (!s || !t) return 96;
  if (s.isCore || t.isCore) return 165;
  return 64 + s.baseRadius + t.baseRadius;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface Rgb { r: number; g: number; b: number; }

const rgbCache = new Map<string, Rgb>();
function toRgb(hex: string): Rgb {
  const cached = rgbCache.get(hex);
  if (cached) return cached;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const rgb = {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
  rgbCache.set(hex, rgb);
  return rgb;
}

function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = toRgb(hex);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
}

function lighten(hex: string, amount: number): string {
  const { r, g, b } = toRgb(hex);
  const m = clamp(amount, 0, 1);
  return `rgb(${Math.round(r + (255 - r) * m)},${Math.round(g + (255 - g) * m)},${Math.round(b + (255 - b) * m)})`;
}

function darken(hex: string, amount: number): string {
  const { r, g, b } = toRgb(hex);
  const m = 1 - clamp(amount, 0, 1);
  return `rgb(${Math.round(r * m)},${Math.round(g * m)},${Math.round(b * m)})`;
}

// Cached soft-glow sprites — one offscreen canvas per colour, reused every
// frame so a dense graph never allocates hundreds of gradients per paint.
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(color: string): HTMLCanvasElement {
  const cached = glowCache.get(color);
  if (cached) return cached;
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, withAlpha(color, 0.85));
  grad.addColorStop(0.32, withAlpha(color, 0.34));
  grad.addColorStop(0.62, withAlpha(color, 0.1));
  grad.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  glowCache.set(color, cv);
  return cv;
}

function isFlowEdge(edge: BrainEdge): boolean {
  return edge.kind === 'feeds' || edge.kind === 'evaluates' || edge.kind === 'co_observed';
}

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return hslToHex(hue, 75, 68);
}

function hslToHex(h: number, s: number, l: number): string {
  const lightness = l / 100;
  const a = (s * Math.min(lightness, 1 - lightness)) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = lightness - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function dotColor(node: BrainNode): string {
  if (node.type === 'warning') return '#fb7185';
  if (node.type === 'gap') return '#94a3b8';

  const tags = node.metadata?.tags;
  const firstTag = Array.isArray(tags) && typeof tags[0] === 'string' ? tags[0] : undefined;
  if (firstTag) {
    return getTagColor(firstTag);
  }

  switch (node.layer) {
    case 'core': return '#e2e8f0';
    case 'knowledge': return '#22d3ee';
    case 'memory': return '#a78bfa';
    case 'judgment': return '#f59e0b';
    default: return '#94a3b8';
  }
}

function shortLabel(label: string): string {
  const clean = label.replace(/\.md$/i, '').trim();
  return clean.length > 26 ? `${clean.slice(0, 25)}…` : clean;
}

function edgeStroke(edge: BrainEdge): string {
  switch (edge.kind) {
    case 'feeds': return '#22d3ee';
    case 'evaluates': return '#a3e635';
    case 'derived_from': return '#a78bfa';
    case 'supports': return '#22c55e';
    case 'contradicts': return '#fb7185';
    case 'refines': return '#94a3b8';
    case 'co_observed': return '#38bdf8';
    case 'used_in': return '#7c83ff';
    case 'supersedes': return '#fb923c';
    case 'measures': return '#f59e0b';
    default: return '#94a3b8';
  }
}

function edgeDash(edge: BrainEdge): number[] | undefined {
  switch (edge.kind) {
    case 'contradicts': return [6, 5];
    case 'refines': return [2, 5];
    default: return undefined;
  }
}

function hashUnit(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}
