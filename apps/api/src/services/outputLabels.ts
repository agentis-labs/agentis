/**
 * outputLabels — semantic outcome aggregation (UIUX §24).
 *
 * Each workflow can declare `settings.outputLabels: string[]` (e.g. ["leads_qualified",
 * "meetings_booked"]). At end-of-run, the runner records counts under
 * `runState.outputCounts: Record<string, number>`. This helper sums counts across
 * a set of completed runs.
 *
 * If a run has no outputCounts, we fall back to counting the run as one
 * "success" event so single-output workflows still appear in the stat bar.
 */

export interface RunWithState {
  status?: string;
  runState?: unknown;
}

export function aggregateOutputLabels(
  runs: readonly RunWithState[],
  labels: readonly string[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const label of labels) totals[label] = 0;

  for (const run of runs) {
    const state =
      run.runState && typeof run.runState === 'object' && !Array.isArray(run.runState)
        ? (run.runState as { outputCounts?: Record<string, unknown> })
        : null;
    const counts = state?.outputCounts;
    if (counts && typeof counts === 'object') {
      for (const [k, v] of Object.entries(counts)) {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) continue;
        totals[k] = (totals[k] ?? 0) + n;
      }
    } else if (labels.length === 1) {
      // Single-label workflows without explicit counts: count successful run as 1.
      totals[labels[0]!] = (totals[labels[0]!] ?? 0) + 1;
    }
  }

  return totals;
}
