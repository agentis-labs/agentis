/**
 * chatMetrics — in-memory tool call metrics for /v1/admin/metrics.
 *
 * Tracks per-tool call counts, error counts, and cumulative duration.
 * No DB writes — ephemeral per-process, reset on restart. This satisfies
 * CHAT-AGENT-LOOP.md §9 "structured logs" requirement with an HTTP surface.
 *
 * Deliberately simple: no reservoir sampling, no ring buffers. Average latency
 * (totalMs / calls) gives the p50 proxy for typical single-model deployments.
 */

interface ToolStat {
  calls: number;
  errors: number;
  totalMs: number;
  /** Rolling last-N latencies for approximate p95 (capped at 200 samples). */
  latencies: number[];
}

const LATENCY_WINDOW = 200;
const stats = new Map<string, ToolStat>();

export function recordToolCall(tool: string, durationMs: number, ok: boolean): void {
  let s = stats.get(tool);
  if (!s) {
    s = { calls: 0, errors: 0, totalMs: 0, latencies: [] };
    stats.set(tool, s);
  }
  s.calls += 1;
  if (!ok) s.errors += 1;
  s.totalMs += durationMs;
  s.latencies.push(durationMs);
  if (s.latencies.length > LATENCY_WINDOW) s.latencies.shift();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

export interface ToolMetricRow {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

export function getToolMetrics(): ToolMetricRow[] {
  return Array.from(stats.entries())
    .map(([tool, s]) => {
      const sorted = [...s.latencies].sort((a, b) => a - b);
      return {
        tool,
        calls: s.calls,
        errors: s.errors,
        errorRate: s.calls > 0 ? s.errors / s.calls : 0,
        avgMs: s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

export function resetToolMetrics(): void {
  stats.clear();
}
