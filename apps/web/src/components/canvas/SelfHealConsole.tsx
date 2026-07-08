/**
 * SelfHealConsole — the immersive face of self-healing.
 *
 * Self-healing is the feature that makes Agentis a serious workflow platform, so
 * it must FEEL different from a normal failure: you watch the agent think, repair,
 * and resolve in real time. The design is deliberately minimal (less is more) —
 * one glyph with a breathing aura, the agent's live diagnosis revealed like a
 * thought, a three-beat phase line (Diagnose · Repair · Resolve), and only the
 * action the moment needs. Everything is driven by the durable incident state, so
 * it stays truthful across refresh/restart.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Wrench, ShieldCheck, AlertTriangle, Check, X, Sparkles, Send, Search, Play } from 'lucide-react';
import clsx from 'clsx';
import type { WorkspaceSelfHealIncident } from '../../lib/workspaceData';
import type { RealtimeActivity } from '../../lib/realtimeActivity';

type Tone = 'accent' | 'warn' | 'success' | 'danger';

const RECOVERY_LADDER = [
  { label: 'Diagnose', Icon: Search },
  { label: 'Inspect', Icon: Activity },
  { label: 'Repair', Icon: Wrench },
  { label: 'Verify', Icon: ShieldCheck },
  { label: 'Resume', Icon: Play },
] as const;

interface StatusView {
  tone: Tone;
  /** active phase index 0..2 */
  phase: number;
  /** is the agent actively working (drives the live "thinking" motion) */
  working: boolean;
  terminal: 'success' | 'failure' | null;
  title: string;
  Icon: typeof Activity;
}

function viewFor(incident: WorkspaceSelfHealIncident): StatusView {
  switch (incident.status) {
    case 'DIAGNOSING':
      return { tone: 'accent', phase: 0, working: true, terminal: null, title: 'Diagnosing the failure', Icon: Activity };
    case 'PLANNING':
    case 'APPLYING':
    case 'RETRYING':
      return { tone: 'accent', phase: 1, working: true, terminal: null, title: 'Repairing the workflow', Icon: Wrench };
    case 'AWAITING_APPROVAL':
      return { tone: 'warn', phase: 1, working: false, terminal: null, title: 'Fix ready for your approval', Icon: Sparkles };
    case 'APPLIED':
      return { tone: 'success', phase: 2, working: false, terminal: 'success', title: 'Workflow self-healed', Icon: ShieldCheck };
    case 'EXHAUSTED':
      return { tone: 'danger', phase: 1, working: false, terminal: 'failure', title: 'Repair attempts exhausted', Icon: AlertTriangle };
    case 'ROLLED_BACK':
      return { tone: 'warn', phase: 2, working: false, terminal: 'failure', title: 'Latest repair rolled back', Icon: AlertTriangle };
    case 'BLOCKED':
    default:
      return { tone: 'danger', phase: 1, working: false, terminal: 'failure', title: "Couldn't safely repair", Icon: AlertTriangle };
  }
}

const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-accent',
  warn: 'text-warn',
  success: 'text-success',
  danger: 'text-danger',
};
const TONE_BG: Record<Tone, string> = {
  accent: 'bg-accent',
  warn: 'bg-warn',
  success: 'bg-success',
  danger: 'bg-danger',
};

/** Reveal text like a thought. Re-runs whenever the text changes. */
function useTypewriter(text: string, animate: boolean): string {
  const [shown, setShown] = useState(animate ? '' : text);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!animate) { setShown(text); return; }
    let i = 0;
    setShown('');
    const start = performance.now();
    const tick = (now: number) => {
      // ~22ms per character, framerate-independent.
      const target = Math.min(text.length, Math.floor((now - start) / 22));
      if (target > i) { i = target; setShown(text.slice(0, i)); }
      if (i < text.length) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [text, animate]);
  return shown;
}

function ladderPosition(incident: WorkspaceSelfHealIncident): number {
  switch (incident.status) {
    case 'DIAGNOSING': return 0;
    case 'PLANNING': return 2;
    case 'AWAITING_APPROVAL':
    case 'APPLYING': return 3;
    case 'RETRYING': return 4;
    case 'APPLIED': return RECOVERY_LADDER.length;
    case 'ROLLED_BACK': return 4;
    case 'BLOCKED':
    case 'EXHAUSTED': return 2;
    default: return 0;
  }
}

export function SelfHealConsole({
  incident,
  activity = [],
  busy = false,
  onResolve,
  onReport,
  onRollback,
}: {
  incident: WorkspaceSelfHealIncident;
  activity?: RealtimeActivity[];
  busy?: boolean;
  onResolve?: (approvalId: string, decision: 'approve' | 'reject') => void;
  onReport?: (incident: WorkspaceSelfHealIncident) => void;
  onRollback?: (checkpointId: string) => void;
}) {
  const view = viewFor(incident);
  const thought = (incident.diagnosis ?? incident.reason ?? '').trim();
  const reveal = useTypewriter(thought, view.working);
  const isAwaiting = incident.status === 'AWAITING_APPROVAL' && Boolean(incident.approvalId);
  const isFailure = view.terminal === 'failure';
  const activeRung = ladderPosition(incident);
  const repairActivity = useMemo(() => {
    const seen = new Set<string>();
    return activity
      .filter((item) => item.kind === 'agent' || item.kind === 'message' || item.kind === 'tool')
      .filter((item) => !item.nodeId || item.nodeId === incident.nodeId || item.taskId === incident.nodeId)
      .filter((item) => item.detail && item.detail !== thought)
      .filter((item) => {
        const key = `${item.kind}:${item.detail}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 4);
  }, [activity, incident.nodeId, thought]);

  return (
    <div
      data-testid="self-heal-console"
      className="sh-rise mb-3 overflow-hidden rounded-xl border border-white/10 bg-canvas/70"
    >
      {/* Header: living glyph + title */}
      <div className="flex items-center gap-2.5 px-3 pt-3">
        <span className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center">
          {view.working && (
            <span className={clsx('sh-aura absolute inset-0 rounded-full', TONE_BG[view.tone], 'opacity-40')} />
          )}
          <span className={clsx('relative inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-surface/80', TONE_TEXT[view.tone])}>
            <view.Icon size={14} className={view.terminal === 'success' ? 'sh-pop' : undefined} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12.5px] font-medium text-text-primary">{view.title}</span>
            {incident.mode === 'bypass' && !view.terminal && (
              <span className="shrink-0 rounded-full border border-white/10 px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wider text-text-muted">
                auto
              </span>
            )}
          </div>
          {incident.nodeTitle && (
            <div className="truncate text-[10.5px] leading-3 text-text-muted">{incident.nodeTitle}</div>
          )}
        </div>
        {incident.maxAttempts > 0 && (
          <span className={clsx('shrink-0 font-mono text-[10px]', isFailure ? 'text-danger/80' : 'text-text-muted')}>
            {incident.attempt}/{incident.maxAttempts}
          </span>
        )}
      </div>

      {/* Live thought */}
      {thought && (
        <div className="relative mx-3 mt-2 overflow-hidden rounded-lg bg-surface/50 px-2.5 py-2">
          {view.working && (
            <span className="sh-scan absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-accent/10 to-transparent" />
          )}
          <p className="relative whitespace-pre-line text-[11px] leading-[1.5] text-text-secondary">
            {view.working ? reveal : thought}
            {view.working && reveal.length < thought.length && (
              <span className={clsx('sh-caret ml-0.5 inline-block h-3 w-px translate-y-0.5', TONE_BG[view.tone])} />
            )}
          </p>
        </div>
      )}

      {incident.tier && (
        <div className="mx-3 mt-2 flex items-center justify-between gap-2 text-[10px] text-text-muted">
          <span className="uppercase tracking-wider">{incident.tier.replace('_', ' ')}</span>
          {incident.riskReason && <span className="truncate">{incident.riskReason}</span>}
        </div>
      )}

      {/* Phase line — Diagnose · Repair · Resolve */}
      {repairActivity.length > 0 && (
        <div className="mx-3 mt-2 border-t border-white/10 pt-2">
          <div className="mb-1.5 text-[9.5px] font-medium uppercase tracking-wider text-text-muted">Live orchestration</div>
          <div className="space-y-1.5">
            {repairActivity.map((item) => (
              <div key={item.id} className="flex min-w-0 items-start gap-2 text-[10.5px] leading-4 text-text-secondary">
                <span className={clsx('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', item.kind === 'tool' ? 'bg-accent' : 'bg-success')} />
                <span className="min-w-0 break-words">{item.kind === 'tool' ? `Used ${item.tool ?? item.detail}` : item.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mx-3 mt-2 border-t border-white/10 py-2.5">
        <div className="mb-2 text-[9.5px] font-medium uppercase tracking-wider text-text-muted">Recovery ladder</div>
        <ol className="grid grid-cols-5 gap-1">
          {RECOVERY_LADDER.map(({ label, Icon }, index) => {
            const complete = activeRung > index;
            const active = activeRung === index && view.terminal !== 'success';
            const failed = isFailure && active;
            return (
              <li key={label} className="min-w-0">
                <span className="mb-1 flex items-center gap-1">
                  <span className={clsx(
                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    complete ? 'border-success/40 bg-success/15 text-success' : active ? `${TONE_TEXT[view.tone]} border-current bg-surface-2` : 'border-white/10 bg-surface/70 text-text-muted',
                    failed && 'border-danger/40 bg-danger/15 text-danger',
                  )}>
                    {complete ? <Check size={9} /> : <Icon size={9} />}
                  </span>
                  {index < RECOVERY_LADDER.length - 1 && <span className={clsx('h-px min-w-0 flex-1', complete ? 'bg-success/45' : 'bg-white/10')} />}
                </span>
                <span className={clsx(
                  'block truncate text-[9px] font-medium uppercase tracking-wider',
                  active ? TONE_TEXT[view.tone] : complete ? 'text-text-secondary' : 'text-text-muted/60',
                )}>{label}</span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Action — only what the moment needs */}
      {isAwaiting && onResolve && (
        <div className="flex gap-2 border-t border-white/10 px-3 py-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve(incident.approvalId!, 'approve')}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-canvas transition hover:bg-accent/90 active:scale-[0.98] disabled:opacity-50"
          >
            <Check size={12} /> Apply fix
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve(incident.approvalId!, 'reject')}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-text-secondary transition hover:text-danger active:scale-[0.98] disabled:opacity-50"
          >
            <X size={12} /> Dismiss
          </button>
        </div>
      )}

      {isFailure && (
        <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-2.5">
          <span className="truncate text-[10.5px] text-text-muted">
            Agentis stopped instead of guessing.
          </span>
          {onReport && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onReport(incident)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition hover:text-text-primary active:scale-[0.98] disabled:opacity-50"
            >
              <Send size={11} /> Report to team
            </button>
          )}
        </div>
      )}

      {incident.status === 'APPLIED' && incident.checkpointId && onRollback && (
        <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-2.5">
          <span className="text-[10.5px] text-text-muted">Latest repair is checkpointed.</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRollback(incident.checkpointId!)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition hover:text-text-primary active:scale-[0.98] disabled:opacity-50"
          >
            <X size={11} /> Roll back
          </button>
        </div>
      )}
    </div>
  );
}



