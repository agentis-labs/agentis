import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Play, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';

/**
 * Per-node test runner.
 *
 * Hits `POST /v1/workflows/:id/nodes/:nodeId/test` against the live engine and
 * shows the structured result inline. Side-effecting nodes (integration,
 * http_request, evaluator) make real calls with real credentials — this is
 * "run this one node now," not a mock.
 */

interface NodeTestRunnerProps {
  workflowId: string;
  nodeId: string;
  /** Last-known inputs for this node (from a previous run). Pre-populates the JSON editor. */
  seedInputs?: Record<string, unknown>;
}

interface TestSuccess { ok: true; output: Record<string, unknown>; durationMs: number; }
interface TestFailure { ok: false; error: string; code?: string; durationMs: number; }
type TestResult = TestSuccess | TestFailure;

export function NodeTestRunner({ workflowId, nodeId, seedInputs }: NodeTestRunnerProps) {
  const [inputs, setInputs] = useState<string>(() => JSON.stringify(seedInputs ?? {}, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  // Re-seed when the user clicks a different node.
  useEffect(() => {
    setInputs(JSON.stringify(seedInputs ?? {}, null, 2));
    setResult(null);
    setParseError(null);
  }, [nodeId, JSON.stringify(seedInputs ?? {})]);

  async function run() {
    setParseError(null);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(inputs);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('inputs must be a JSON object');
      }
    } catch (err) {
      setParseError((err as Error).message);
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const body = await api<TestResult>(`/v1/workflows/${workflowId}/nodes/${nodeId}/test`, {
        method: 'POST',
        body: JSON.stringify({ inputs: parsed }),
      });
      setResult(body);
    } catch (err) {
      setResult({
        ok: false,
        error: (err as { message?: string }).message ?? 'request failed',
        durationMs: 0,
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[11px] font-medium text-text-secondary">Inputs (JSON)</label>
          <button
            type="button"
            onClick={() => { setInputs(JSON.stringify(seedInputs ?? {}, null, 2)); setParseError(null); }}
            className="inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-text-secondary"
            title="Reset inputs to the last run's values"
          >
            <RotateCcw size={10} /> Reset
          </button>
        </div>
        <textarea
          rows={8}
          spellCheck={false}
          className={clsx(
            'w-full resize-none rounded-input border bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-primary focus:outline-none',
            parseError ? 'border-danger focus:border-danger' : 'border-line focus:border-accent',
          )}
          value={inputs}
          onChange={(e) => { setInputs(e.target.value); setParseError(null); }}
        />
        {parseError && <p className="mt-1 text-[10px] text-danger">{parseError}</p>}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
        >
          <Play size={12} /> {running ? 'Running…' : 'Run node'}
        </button>
        {result && (
          <span className={clsx('text-[10px]', result.ok ? 'text-text-secondary' : 'text-danger')}>
            {result.ok ? `OK · ${result.durationMs}ms` : `${result.code ?? 'ERROR'} · ${result.durationMs}ms`}
          </span>
        )}
      </div>
      {result && (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-canvas p-2">
          {result.ok ? (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">Output</div>
              <pre className="m-0 whitespace-pre-wrap font-mono text-[11px] text-text-primary">{JSON.stringify(result.output, null, 2)}</pre>
            </>
          ) : (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-danger">Error</div>
              <p className="font-mono text-[11px] text-text-primary">{result.error}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}



