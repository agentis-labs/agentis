/**
 * charts — a dependency-free SVG chart kit for the AG-UI renderer.
 *
 * No runtime chart library (keeps the bundle lean + supply-chain clean); pure
 * SVG geometry, token-driven colours. Supports line / area / bar / stacked-bar /
 * pie / donut and a tiny inline Sparkline. Reused by the code-surface tier.
 */
import { useId, useState, type MouseEvent } from 'react';
import type { AccentName } from '@agentis/core';
import { accentColor, seriesColor } from '../theme';

export interface ChartSeries {
  y: string;
  label?: string;
  color?: AccentName;
}

export interface DataChartProps {
  rows: Array<Record<string, unknown>>;
  x: string;
  series: ChartSeries[];
  chartType: 'line' | 'bar' | 'pie' | 'area' | 'donut';
  stacked?: boolean;
  area?: boolean;
  height?: number;
  legend?: boolean;
  curve?: 'linear' | 'smooth';
  /** Design-language policy: suppress gradient area fills when false (e.g. editorial). Default true. */
  gradientFill?: boolean;
}

const W = 640;
const PAD = { l: 46, r: 16, t: 16, b: 28 };

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function niceTicks(min: number, max: number, count = 4): number[] {
  if (max <= min) return [min, max];
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + step * i);
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function ChartEmpty({ height }: { height?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-card border border-dashed border-line bg-canvas text-[11px] text-text-muted"
      style={{ height: Math.min(height ?? 80, 80) }}
    >
      No data yet
    </div>
  );
}

function Legend({ series }: { series: ChartSeries[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s, i) => (
        <span key={s.y} className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary">
          <span className="h-2 w-2 rounded-full" style={{ background: seriesColor(i, s.color) }} />
          {s.label ?? s.y}
        </span>
      ))}
    </div>
  );
}

export function DataChart(props: DataChartProps) {
  const { rows, series, chartType } = props;
  if (rows.length === 0 || series.length === 0) return <ChartEmpty height={props.height} />;
  if (chartType === 'pie' || chartType === 'donut') return <PieChart {...props} />;
  return <CartesianChart {...props} />;
}

// ── Line / area / bar / stacked ─────────────────────────────

function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 3) return linearPath(pts);
  const first = pts[0]!;
  let d = `M ${first[0]} ${first[1]}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function linearPath(pts: Array<[number, number]>): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
}

function CartesianChart(props: DataChartProps) {
  const { rows, x, series, chartType, stacked, area, legend, curve, height, gradientFill } = props;
  const H = height ?? 200;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const gradId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const categories = rows.map((r) => String(r[x] ?? ''));
  const n = categories.length;
  const isBar = chartType === 'bar';

  // y-domain
  let yMax = 0;
  let yMin = 0;
  if (isBar && stacked) {
    for (const row of rows) {
      const total = series.reduce((acc, s) => acc + num(row[s.y]), 0);
      yMax = Math.max(yMax, total);
    }
  } else {
    for (const row of rows) {
      for (const s of series) {
        const v = num(row[s.y]);
        yMax = Math.max(yMax, v);
        yMin = Math.min(yMin, v);
      }
    }
  }
  if (yMax === yMin) yMax = yMin + 1;

  const bw = innerW / Math.max(1, n);
  const cx = (i: number): number => PAD.l + bw * (i + 0.5);
  const y = (v: number): number => PAD.t + innerH * (1 - (v - yMin) / (yMax - yMin));
  const ticks = niceTicks(yMin, yMax);
  const labelStep = Math.max(1, Math.ceil(n / 8));
  // Hover crosshair + tooltip: the SVG stretches only on X (viewBox H = pixel H),
  // so the mouse-x fraction maps linearly to a category and the tooltip can be
  // placed by percentage — no ref/measure needed.
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round((vbX - PAD.l) / bw - 0.5))));
  };
  const tipLeft = hover != null ? Math.max(12, Math.min(88, (cx(hover) / W) * 100)) : 0;

  return (
    <div className="s-panel p-3">
      <div className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" preserveAspectRatio="none">
        {/* gridlines + y labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">{fmt(t)}</text>
          </g>
        ))}
        {/* x labels */}
        {categories.map((c, i) => (i % labelStep === 0 ? (
          <text key={i} x={cx(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--color-text-muted)">
            {c.length > 10 ? `${c.slice(0, 9)}…` : c}
          </text>
        ) : null))}

        {isBar
          ? <Bars rows={rows} series={series} stacked={Boolean(stacked)} bw={bw} cx={cx} y={y} y0={y(Math.max(0, yMin))} />
          : series.map((s, si) => {
            const color = seriesColor(si, s.color);
            const pts = rows.map((r, i) => [cx(i), y(num(r[s.y]))] as [number, number]);
            const d = curve === 'smooth' ? smoothPath(pts) : linearPath(pts);
            const baseline = y(Math.max(0, yMin));
            const fillArea = (area || chartType === 'area') && gradientFill !== false;
            return (
              <g key={s.y}>
                {fillArea && pts.length > 0 ? (
                  <>
                    <defs>
                      <linearGradient id={`${gradId}-${si}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity={0.32} />
                        <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <path d={`${d} L ${pts[pts.length - 1]![0]} ${baseline} L ${pts[0]![0]} ${baseline} Z`} fill={`url(#${gradId}-${si})`} />
                  </>
                ) : null}
                <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {pts.map((p, i) => {
                  const isLast = i === pts.length - 1;
                  return (
                    <g key={i}>
                      {isLast ? <circle cx={p[0]} cy={p[1]} r={6} fill={color} opacity={0.18} /> : null}
                      <circle cx={p[0]} cy={p[1]} r={isLast ? 3.5 : 2.5} fill={isLast ? 'var(--color-surface)' : color} stroke={color} strokeWidth={isLast ? 2 : 0}>
                        <title>{`${categories[i] ?? ''}: ${fmt(num(rows[i]?.[s.y]))}`}</title>
                      </circle>
                    </g>
                  );
                })}
              </g>
            );
          })}
        {hover != null ? (
          <>
            <line x1={cx(hover)} x2={cx(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-line-strong)" strokeWidth={1} strokeDasharray="3 3" />
            {!isBar ? series.map((s, si) => (
              <circle key={`h-${s.y}`} cx={cx(hover)} cy={y(num(rows[hover]?.[s.y]))} r={3.5} fill="var(--color-surface)" stroke={seriesColor(si, s.color)} strokeWidth={2} />
            )) : null}
          </>
        ) : null}
      </svg>
        {hover != null ? (
          <div className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-card border border-line-strong bg-glass px-2.5 py-1.5 text-[11px] shadow-dropdown" style={{ left: `${tipLeft}%` }}>
            <div className="mb-0.5 font-medium text-text-primary">{categories[hover]}</div>
            {series.map((s, si) => (
              <div key={`t-${s.y}`} className="flex items-center gap-1.5 text-text-secondary">
                <span className="h-2 w-2 rounded-full" style={{ background: seriesColor(si, s.color) }} />
                <span>{s.label ?? s.y}</span>
                <span className="ml-2 tabular-nums text-text-primary">{fmt(num(rows[hover]?.[s.y]))}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {legend !== false && series.length > 1 ? <Legend series={series} /> : null}
    </div>
  );
}

function Bars({
  rows, series, stacked, bw, cx, y, y0,
}: {
  rows: Array<Record<string, unknown>>;
  series: ChartSeries[];
  stacked: boolean;
  bw: number;
  cx: (i: number) => number;
  y: (v: number) => number;
  y0: number;
}) {
  const inner = bw * 0.7;
  return (
    <>
      {rows.map((row, i) => {
        const center = cx(i);
        if (stacked) {
          let acc = 0;
          return (
            <g key={i}>
              {series.map((s, si) => {
                const v = num(row[s.y]);
                const top = y(acc + v);
                const bottom = y(acc);
                acc += v;
                return <rect key={s.y} x={center - inner / 2} y={top} width={inner} height={Math.max(0, bottom - top)} fill={seriesColor(si, s.color)} rx={1}><title>{`${s.label ?? s.y}: ${fmt(v)}`}</title></rect>;
              })}
            </g>
          );
        }
        const sub = inner / series.length;
        return (
          <g key={i}>
            {series.map((s, si) => {
              const v = num(row[s.y]);
              const top = y(v);
              const xPos = center - inner / 2 + sub * si;
              return <rect key={s.y} x={xPos} y={top} width={Math.max(1, sub - 2)} height={Math.max(0, y0 - top)} fill={seriesColor(si, s.color)} rx={1}><title>{`${s.label ?? s.y}: ${fmt(v)}`}</title></rect>;
            })}
          </g>
        );
      })}
    </>
  );
}

// ── Pie / donut ─────────────────────────────────────────────

function PieChart({ rows, x, series, chartType, height, legend }: DataChartProps) {
  const H = height ?? 200;
  const key = series[0]?.y ?? 'value';
  const slices = rows.map((r, i) => ({ label: String(r[x] ?? `#${i + 1}`), value: Math.max(0, num(r[key])), color: seriesColor(i) }));
  const total = slices.reduce((acc, s) => acc + s.value, 0);
  const R = Math.min(H, 260) / 2 - 8;
  const cx = R + 8;
  const cy = H / 2;
  const inner = chartType === 'donut' ? R * 0.58 : 0;

  let angle = -Math.PI / 2;
  const arcs = slices.map((s) => {
    const frac = total > 0 ? s.value / total : 0;
    const start = angle;
    const end = angle + frac * Math.PI * 2;
    angle = end;
    const large = end - start > Math.PI ? 1 : 0;
    const p = (r: number, a: number): string => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
    const d = inner > 0
      ? `M ${p(inner, start)} L ${p(R, start)} A ${R} ${R} 0 ${large} 1 ${p(R, end)} L ${p(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, start)} Z`
      : `M ${cx} ${cy} L ${p(R, start)} A ${R} ${R} 0 ${large} 1 ${p(R, end)} Z`;
    return { d, ...s, pct: frac };
  });

  return (
    <div className="s-panel flex flex-wrap items-center gap-4 p-3">
      <svg viewBox={`0 0 ${R * 2 + 16} ${H}`} style={{ height: H, width: R * 2 + 16 }} role="img">
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill={a.color} stroke="var(--color-surface)" strokeWidth={1.5}>
            <title>{`${a.label}: ${fmt(a.value)} (${Math.round(a.pct * 100)}%)`}</title>
          </path>
        ))}
      </svg>
      {legend !== false ? (
        <div className="flex min-w-[120px] flex-col gap-1.5">
          {arcs.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-2 text-[11px] text-text-secondary">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} />
              <span className="truncate">{a.label}</span>
              <span className="ml-auto tabular-nums text-text-muted">{Math.round(a.pct * 100)}%</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Sparkline (tiny inline trend) ───────────────────────────

export function Sparkline({ points, color, height = 32, accent }: { points: number[]; color?: string; height?: number; accent?: AccentName }) {
  const stroke = color ?? accentColor(accent);
  if (points.length < 2) return <div style={{ height }} className="rounded bg-canvas" />;
  const w = 120;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const pts = points.map((v, i) => [
    (i / (points.length - 1)) * w,
    height - 2 - ((v - min) / span) * (height - 4),
  ] as [number, number]);
  const id = useId();
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${linearPath(pts)} L ${w} ${height} L 0 ${height} Z`} fill={`url(#${id})`} />
      <path d={linearPath(pts)} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
