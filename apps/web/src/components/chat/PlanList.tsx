import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import type { ToolCallPillData } from '../ChatPanel/ToolCallPill';

export interface ParsedPlan {
  before: string;
  after: string;
  items: string[];
}

export interface PlanItemView {
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

export function extractPlan(text: string): ParsedPlan | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\d+\.\s+\S/.test(lines[index] ?? '')) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;

  const items: string[] = [];
  let end = start;
  while (end < lines.length) {
    const match = lines[end]?.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (!match) break;
    items.push(match[1] ?? '');
    end += 1;
  }
  if (items.length < 2) return null;

  const beforeLines = lines.slice(0, start);
  if (/^\s*plan\s*:?\s*$/i.test(beforeLines.at(-1) ?? '')) beforeLines.pop();

  return {
    before: beforeLines.join('\n').trim(),
    after: lines.slice(end).join('\n').trim(),
    items,
  };
}

export function derivePlanItems(
  labels: string[],
  toolCalls: ToolCallPillData[] = [],
  streaming = false,
): PlanItemView[] {
  const successful = toolCalls.filter((call) => call.status === 'success').length;
  const failed = toolCalls.filter((call) => call.status === 'error').length;
  const running = toolCalls.some((call) => call.status === 'running') || streaming;
  const anyFinished = successful + failed > 0;
  const allToolCallsDone = toolCalls.length > 0 && toolCalls.every((call) => call.status !== 'running');

  return labels.map((label, index) => {
    if (failed > 0 && index === Math.min(successful, labels.length - 1)) return { label, status: 'failed' };
    if (allToolCallsDone && failed === 0) return { label, status: 'done' };
    if (index < successful) return { label, status: 'done' };
    if (index === successful && running && (toolCalls.length > 0 || anyFinished)) return { label, status: 'running' };
    return { label, status: 'pending' };
  });
}

export function PlanList({ items }: { items: PlanItemView[] }) {
  if (items.length === 0) return null;

  return (
    <div className="mb-2 rounded-xl border border-line/70 bg-canvas/65 p-2.5 text-[12px] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">Plan</div>
      <ol className="space-y-1.5">
        {items.map((item, index) => (
          <li key={`${index}-${item.label}`} className="flex items-start gap-2">
            <PlanStatusIcon status={item.status} />
            <span className={clsx(
              'min-w-0 flex-1 leading-relaxed transition-colors duration-300',
              item.status === 'pending' && 'text-text-muted',
              item.status === 'running' && 'text-text-primary',
              item.status === 'done' && 'text-text-secondary line-through decoration-line/80',
              item.status === 'failed' && 'text-danger',
            )}>
              {item.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PlanStatusIcon({ status }: { status: PlanItemView['status'] }) {
  if (status === 'running') return <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-accent" />;
  if (status === 'done') return <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-accent" />;
  if (status === 'failed') return <XCircle size={13} className="mt-0.5 shrink-0 text-danger" />;
  return <Circle size={13} className="mt-0.5 shrink-0 text-text-muted" />;
}
