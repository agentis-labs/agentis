/**
 * Agent constellation — V1-SPEC §13.6.
 *
 * Renders the workspace's agents as colored dots clustered by gateway. We
 * deliberately implement the physics by hand (lightweight spring + repulsion
 * loop on requestAnimationFrame) instead of pulling d3-force, because the
 * fleet is small (V1 caps cells at ~50 agents) and the dependency footprint
 * matters for the dashboard's cold-start budget.
 *
 * The layout is deterministic-ish across renders: the seed is the gatewayId
 * so the same workspace produces the same cluster centers between sessions.
 *
 * Click an agent → navigates to /agents/:id (the AgentDetail page).
 *
 * Used standalone on FleetOverviewPage and AgentFleetPage (Constellation tab).
 */

import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export interface ConstellationAgent {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'busy' | 'error';
  colorHex: string;
  gatewayId: string | null;
}

interface Body {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const REPULSION = 4000;
const SPRING = 0.012;
const DAMPING = 0.78;
const MIN_VELOCITY = 0.05;

export function AgentConstellation({
  agents,
  height = 320,
  onSelect,
}: {
  agents: ConstellationAgent[];
  height?: number;
  onSelect?: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const bodiesRef = useRef<Map<string, Body>>(new Map());
  const rafRef = useRef<number>(0);
  const nav = useNavigate();

  // Cluster centers per gateway, deterministic from a string hash.
  const clusters = useMemo(() => {
    const ids = Array.from(new Set(agents.map((a) => a.gatewayId ?? 'standalone')));
    const map = new Map<string, { x: number; y: number }>();
    ids.forEach((gid, i) => {
      const angle = (i / Math.max(1, ids.length)) * Math.PI * 2 + hash(gid) * 0.7;
      const radius = 110;
      map.set(gid, {
        x: 240 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius,
      });
    });
    return map;
  }, [agents, height]);

  useEffect(() => {
    // Seed bodies for any newly seen agents.
    for (const a of agents) {
      if (!bodiesRef.current.has(a.id)) {
        const c = clusters.get(a.gatewayId ?? 'standalone') ?? { x: 240, y: height / 2 };
        bodiesRef.current.set(a.id, {
          id: a.id,
          x: c.x + (hash(a.id) - 0.5) * 40,
          y: c.y + (hash(a.id + 'y') - 0.5) * 40,
          vx: 0,
          vy: 0,
        });
      }
    }
    // Drop bodies for removed agents.
    const present = new Set(agents.map((a) => a.id));
    for (const id of bodiesRef.current.keys()) {
      if (!present.has(id)) bodiesRef.current.delete(id);
    }

    function step() {
      const bodies = Array.from(bodiesRef.current.values());
      for (const b of bodies) {
        const a = agents.find((x) => x.id === b.id);
        if (!a) continue;
        const c = clusters.get(a.gatewayId ?? 'standalone') ?? { x: 240, y: height / 2 };
        // Spring toward cluster center.
        b.vx += (c.x - b.x) * SPRING;
        b.vy += (c.y - b.y) * SPRING;
        // Repulsion from other bodies.
        for (const other of bodies) {
          if (other.id === b.id) continue;
          const dx = b.x - other.x;
          const dy = b.y - other.y;
          const d2 = Math.max(40, dx * dx + dy * dy);
          const f = REPULSION / d2;
          b.vx += (dx / Math.sqrt(d2)) * f * 0.001;
          b.vy += (dy / Math.sqrt(d2)) * f * 0.001;
        }
        b.vx *= DAMPING;
        b.vy *= DAMPING;
        b.x += b.vx;
        b.y += b.vy;
      }
      // Render.
      const svg = svgRef.current;
      if (svg) {
        for (const b of bodies) {
          const node = svg.querySelector<SVGGElement>(`g[data-id="${b.id}"]`);
          if (node) node.setAttribute('transform', `translate(${b.x.toFixed(2)} ${b.y.toFixed(2)})`);
        }
      }
      // Stop when settled.
      const moving = bodies.some((b) => Math.abs(b.vx) + Math.abs(b.vy) > MIN_VELOCITY);
      if (moving) rafRef.current = requestAnimationFrame(step);
      else rafRef.current = 0;
    }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [agents, clusters, height]);

  function pick(id: string) {
    if (onSelect) onSelect(id);
    else nav(`/agents/${id}`);
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 480 ${height}`}
      className="h-full w-full"
      role="img"
      aria-label="Agent constellation"
    >
      {Array.from(clusters.entries()).map(([gid, c]) => (
        <g key={gid}>
          <circle cx={c.x} cy={c.y} r={70} fill="#9cffb008" stroke="#9cffb022" />
          <text
            x={c.x}
            y={c.y - 80}
            textAnchor="middle"
            className="fill-text-muted text-[10px] uppercase tracking-wider"
          >
            {gid === 'standalone' ? 'standalone' : gid.slice(0, 6)}
          </text>
        </g>
      ))}
      {agents.map((a) => (
        <g key={a.id} data-id={a.id} className="cursor-pointer" onClick={() => pick(a.id)}>
          <circle r={9} fill={a.colorHex} opacity={a.status === 'offline' ? 0.35 : 0.95} />
          <circle r={11} fill="none" stroke={a.colorHex} opacity={a.status === 'busy' ? 0.7 : 0} />
          <title>
            {a.name} — {a.status}
          </title>
        </g>
      ))}
    </svg>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000;
}
