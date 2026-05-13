import type { LlmTraceSpan } from '@agentis/core';
import clsx from 'clsx';
import { GitBranch } from 'lucide-react';

export function XRayPanel({
  span,
  nodeId,
  onForkFromNode,
}: {
  span: LlmTraceSpan | null;
  nodeId?: string;
  onForkFromNode?: (nodeId: string) => void;
}) {
  if (!span) {
    return (
      <div className="space-y-3 text-[11px] text-text-muted">
        <div className="rounded-md border border-line bg-surface-2 p-3">
          No X-Ray trace captured for this node yet.
        </div>
        {nodeId && onForkFromNode && (
          <button
            type="button"
            onClick={() => onForkFromNode(nodeId)}
            className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-[10px] text-text-primary hover:border-accent/40 hover:text-accent"
          >
            <GitBranch size={11} /> Fork run from here
          </button>
        )}
      </div>
    );
  }

  const context = span.contextStrategy;
  const rawPrompt = stringifyPrompt(span.payloads?.rawPrompt);
  const tokens = span.payloads?.tokenReplay?.tokens ?? tokenizeApprox(rawPrompt);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Tokens" value={formatNumber(span.metrics.totalTokens)} />
        <Metric label="Cost" value={formatCost(span.metrics.totalCostMicros)} />
        <Metric label="Latency" value={formatDuration(span.metrics.latencyMs)} />
        <Metric label="Cached" value={formatNumber(span.metrics.cachedTokens)} />
      </div>

      {context && <ContextTube context={context} />}

      {nodeId && onForkFromNode && (
        <button
          type="button"
          onClick={() => onForkFromNode(nodeId)}
          className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1.5 text-[10px] text-accent hover:border-accent/60"
        >
          <GitBranch size={11} /> Fork run from here
        </button>
      )}

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">Token replay</div>
        <div className="max-h-56 overflow-auto rounded-md border border-line bg-surface-2 p-2 font-mono text-[10px] leading-relaxed">
          {tokens.slice(0, 600).map((token, index) => (
            <span
              key={`${index}-${token.text}`}
              title={`${token.tokenCount} token${token.tokenCount === 1 ? '' : 's'}${token.logprob !== undefined ? ` · logprob ${token.logprob.toFixed(3)}` : ''}`}
              className={clsx(
                'rounded px-0.5',
                token.logprob !== undefined && token.logprob < -2
                  ? 'bg-danger/20 text-danger'
                  : token.tokenCount >= 3
                    ? 'bg-warn/15 text-warn'
                    : 'text-text-muted',
              )}
            >
              {token.text}
            </span>
          ))}
          {tokens.length === 0 && <span className="text-text-muted">No prompt payload available.</span>}
        </div>
      </div>

      <details>
        <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-text-muted">Raw payload</summary>
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface-2 p-2 font-mono text-[10px] text-text-muted">
          {JSON.stringify({ prompt: span.payloads?.rawPrompt ?? null, completion: span.payloads?.rawCompletion ?? null, toolCalls: span.payloads?.toolCalls ?? [] }, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface-2 p-2">
      <div className="text-[9px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-text-primary">{value}</div>
    </div>
  );
}

function ContextTube({ context }: { context: NonNullable<LlmTraceSpan['contextStrategy']> }) {
  const used = context.blocks.reduce((total, block) => total + block.tokenCount, 0);
  const truncated = context.blocks.reduce((total, block) => total + block.truncatedTokens, 0);
  return (
    <div className="rounded-md border border-line bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-text-muted">
        <span>Context tube</span>
        <span className="font-mono">{formatNumber(used)} / {formatNumber(context.windowLimit)}</span>
      </div>
      <div className="flex h-5 overflow-hidden rounded bg-canvas">
        {context.blocks.map((block, index) => {
          const width = Math.max(2, Math.min(100, (block.tokenCount / context.windowLimit) * 100));
          return (
            <div
              key={`${block.source}-${index}`}
              title={`${block.label ?? block.source}: ${formatNumber(block.tokenCount)} tokens${block.truncatedTokens ? ` · ${formatNumber(block.truncatedTokens)} dropped` : ''}`}
              className={clsx('h-full border-r border-canvas/70', sourceTone(block.source))}
              style={{ width: `${width}%` }}
            />
          );
        })}
        {truncated > 0 && (
          <div
            title={`${formatNumber(truncated)} truncated tokens`}
            className="h-full"
            style={{
              width: `${Math.max(3, Math.min(100, (truncated / context.windowLimit) * 100))}%`,
              background: 'repeating-linear-gradient(45deg, rgba(255, 122, 122, 0.9), rgba(255, 122, 122, 0.9) 4px, rgba(255, 122, 122, 0.35) 4px, rgba(255, 122, 122, 0.35) 8px)',
            }}
          />
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-text-muted">
        {context.blocks.map((block, index) => (
          <div key={`${block.source}-label-${index}`} className="min-w-0 truncate">
            <span className={clsx('mr-1 inline-block h-2 w-2 rounded-sm', sourceTone(block.source))} />
            {block.label ?? block.source}: {formatNumber(block.tokenCount)}t
          </div>
        ))}
      </div>
    </div>
  );
}

function sourceTone(source: string): string {
  switch (source) {
    case 'system': return 'bg-sky-400/80';
    case 'memory': return 'bg-fuchsia-400/80';
    case 'retrieval': return 'bg-emerald-400/80';
    case 'tools': return 'bg-amber-400/80';
    case 'user':
    case 'input': return 'bg-accent/80';
    case 'scratchpad': return 'bg-indigo-400/80';
    default: return 'bg-text-muted/60';
  }
}

function stringifyPrompt(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

function tokenizeApprox(text: string): Array<{ text: string; tokenCount: number; logprob?: number }> {
  return text.match(/\s+|[^\s]+/g)?.map((token) => ({
    text: token,
    tokenCount: Math.max(1, Math.ceil(token.length / 4)),
  })) ?? [];
}

function formatCost(costMicros: number): string {
  return costMicros > 0 ? `$${(costMicros / 1_000_000).toFixed(4)}` : '$0.0000';
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : '0';
}