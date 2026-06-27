/**
 * Console panels (LIVING-APPS-10X §6) — the operator's glanceable lenses on a
 * resident App, binding APIs that already shipped:
 *
 *   PipelinePanel  → appsApi.contacts   (Phase 3 — the relationship, grouped by stage)
 *   LearningsPanel → appsApi.learnings  (Phase M2 — what this agent learned)
 *   RehearsalPanel → appsApi.simulate   (G8 — drive a scenario, see the scored run)
 *
 * Calm and minimal by design (the DNA: glanceable before deep, no forty knobs).
 * Each renders nothing-but-an-empty-state when its data is absent, so a legacy or
 * unstaffed App shows no clutter.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, GraduationCap, Lightbulb, Play, RefreshCw, Target, XCircle } from 'lucide-react';
import {
  appsApi,
  type AppContact,
  type AppLearnings,
  type SimulationResult,
  type SimulatorScenario,
} from '../../lib/appsApi';
import { apiErrorMessage } from '../../lib/api';

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${diff < 0 ? 'in ' : ''}${mins}m${diff < 0 ? '' : ' ago'}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${diff < 0 ? 'in ' : ''}${hrs}h${diff < 0 ? '' : ' ago'}`;
  const days = Math.round(hrs / 24);
  return `${diff < 0 ? 'in ' : ''}${days}d${diff < 0 ? '' : ' ago'}`;
}

const PanelHeader = ({ icon, title, hint, onRefresh, busy }: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  onRefresh?: () => void;
  busy?: boolean;
}) => (
  <div className="mb-3 flex items-center gap-2">
    <span className="text-text-muted">{icon}</span>
    <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
    {hint ? <span className="text-[11px] text-text-muted">{hint}</span> : null}
    {onRefresh ? (
      <button
        type="button"
        onClick={onRefresh}
        className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
        title="Refresh"
      >
        <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
      </button>
    ) : null}
  </div>
);

// ── Pipeline board (Phase 3) ─────────────────────────────────

export function PipelinePanel({ appId }: { appId: string }) {
  const [contacts, setContacts] = useState<AppContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    appsApi.contacts(appId)
      .then((rows) => { setContacts(rows); setError(null); })
      .catch((e) => setError(apiErrorMessage(e)))
      .finally(() => setBusy(false));
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const groups = new Map<string, AppContact[]>();
  for (const contact of contacts ?? []) {
    const stage = (contact.stage && contact.stage.trim()) || 'new';
    const bucket = groups.get(stage) ?? [];
    bucket.push(contact);
    groups.set(stage, bucket);
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <PanelHeader
        icon={<Target size={14} />}
        title="Pipeline"
        hint={contacts ? `${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'}` : undefined}
        onRefresh={load}
        busy={busy}
      />
      {error ? <div className="text-[12px] text-danger">{error}</div> : null}
      {!error && contacts && contacts.length === 0 ? (
        <div className="rounded-md border border-dashed border-line bg-surface-2 px-3 py-4 text-[12px] text-text-muted">
          No contacts yet. Connect a channel — the resident agent records each person it talks to here.
        </div>
      ) : null}
      <div className="flex flex-col gap-4">
        {[...groups.entries()].map(([stage, rows]) => (
          <div key={stage}>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{titleCase(stage)}</span>
              <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-medium text-text-muted">{rows.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {rows.map((contact) => (
                <div key={contact.id} className="rounded-md border border-line bg-surface-2 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[12px] font-medium text-text-primary">
                      {contact.displayName || contact.handle || 'Unknown'}
                    </span>
                    {contact.channelKind ? (
                      <span className="rounded bg-surface-3 px-1.5 text-[10px] text-text-muted">{contact.channelKind}</span>
                    ) : null}
                    {contact.outcome ? (
                      <span className={`ml-auto text-[10px] font-medium ${contact.outcome === 'won' ? 'text-success' : 'text-text-muted'}`}>
                        {titleCase(contact.outcome)}
                      </span>
                    ) : null}
                  </div>
                  {contact.goal ? <div className="mt-0.5 truncate text-[11px] text-text-secondary">{contact.goal}</div> : null}
                  {contact.nextTouchAt ? (
                    <div className="mt-0.5 text-[10px] text-accent">Follow up {relTime(contact.nextTouchAt)}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Learnings (Phase M2) ─────────────────────────────────────

export function LearningsPanel({ appId }: { appId: string }) {
  const [data, setData] = useState<AppLearnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    appsApi.learnings(appId)
      .then((rows) => { setData(rows); setError(null); })
      .catch((e) => setError(apiErrorMessage(e)))
      .finally(() => setBusy(false));
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const empty = data && data.lessons.length === 0 && data.abilities.length === 0;

  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <PanelHeader icon={<Lightbulb size={14} />} title="What this agent learned" onRefresh={load} busy={busy} />
      {error ? <div className="text-[12px] text-danger">{error}</div> : null}
      {!error && empty ? (
        <div className="rounded-md border border-dashed border-line bg-surface-2 px-3 py-4 text-[12px] text-text-muted">
          Nothing learned yet. As relationships close won or lost, the agent banks graded lessons here — and recurring
          winning patterns graduate into reusable abilities.
        </div>
      ) : null}
      {data && data.abilities.length > 0 ? (
        <div className="mb-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Graduated abilities</div>
          <div className="flex flex-col gap-1.5">
            {data.abilities.map((ability) => (
              <div key={ability.id} className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2">
                <GraduationCap size={13} className="shrink-0 text-accent" />
                <span className="truncate text-[12px] font-medium text-text-primary">{ability.name}</span>
                {ability.domainTag ? (
                  <span className="rounded bg-surface-3 px-1.5 text-[10px] text-text-muted">{ability.domainTag}</span>
                ) : null}
                <span className="ml-auto text-[10px] text-text-muted">{relTime(ability.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {data && data.lessons.length > 0 ? (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Recent lessons</div>
          <div className="flex flex-col gap-1.5">
            {data.lessons.map((lesson) => (
              <div key={lesson.id} className="rounded-md border border-line bg-surface-2 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12px] font-medium text-text-primary">{lesson.title}</span>
                  {lesson.outcome ? (
                    <span className={`ml-auto text-[10px] font-medium ${lesson.outcome === 'won' ? 'text-success' : 'text-text-muted'}`}>
                      {titleCase(lesson.outcome)}
                    </span>
                  ) : null}
                </div>
                {lesson.summary ? <div className="mt-0.5 text-[11px] leading-relaxed text-text-secondary">{lesson.summary}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── Rehearsal (G8) ───────────────────────────────────────────

const SAMPLE_SCENARIO = `Customer is "Maria, a price-sensitive first-time buyer". She opens by asking if the product is still available, then pushes for a discount. The agent should qualify her budget and never promise a discount it isn't authorized to give.`;

export function RehearsalPanel({ appId }: { appId: string }) {
  const [personaPrompt, setPersonaPrompt] = useState(SAMPLE_SCENARIO);
  const [goal, setGoal] = useState('Reserve the item / move toward a sale');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    const prompt = personaPrompt.trim();
    if (!prompt) return;
    const scenario: SimulatorScenario = {
      name: 'Rehearsal',
      persona: { name: 'Synthetic customer', prompt },
      goal: goal.trim() || 'Reach a positive outcome',
      // A couple of light guardrails/expectations so the deterministic score is meaningful
      // even with no judge model wired.
      guardrails: [{ id: 'no_discount', label: 'never promise an unauthorized discount', pattern: 'discount' }],
      expectations: [{ id: 'ask_budget', label: 'ask about budget', pattern: 'budget' }],
    };
    setRunning(true);
    setError(null);
    appsApi.simulate(appId, scenario)
      .then((res) => setResult(res))
      .catch((e) => setError(apiErrorMessage(e)))
      .finally(() => setRunning(false));
  }, [appId, personaPrompt, goal]);

  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <PanelHeader icon={<Play size={14} />} title="Rehearsal" hint="drive a scenario, see the scored run" />
      <div className="flex flex-col gap-2">
        <label className="text-[11px] font-medium text-text-muted">Scenario (the synthetic customer)</label>
        <textarea
          value={personaPrompt}
          onChange={(e) => setPersonaPrompt(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-md border border-line bg-surface-2 px-2.5 py-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
          placeholder="Describe the customer, their situation, and what they want…"
        />
        <label className="text-[11px] font-medium text-text-muted">Goal of a successful conversation</label>
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={run}
          disabled={running || !personaPrompt.trim()}
          className="mt-1 inline-flex h-8 w-fit items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {running ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
          {running ? 'Running…' : 'Run rehearsal'}
        </button>
      </div>

      {error ? <div className="mt-3 text-[12px] text-danger">{error}</div> : null}

      {result ? (
        <div className="mt-4 flex flex-col gap-3">
          {/* Score header */}
          <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3 py-2">
            <span className="text-[20px] font-semibold text-text-primary">{Math.round(result.score.score * 100)}</span>
            <span className="text-[11px] text-text-muted">/ 100</span>
            <span className={`ml-1 inline-flex items-center gap-1 text-[12px] font-medium ${result.score.goalReached ? 'text-success' : 'text-text-muted'}`}>
              {result.score.goalReached ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              {result.score.goalReached ? 'Goal reached' : 'Goal not reached'}
            </span>
            <span className="ml-auto text-[10px] text-text-muted">{result.generated ? 'model-driven' : 'scripted'}</span>
          </div>

          {/* Guardrail violations — highlighted. */}
          {result.score.guardrailViolations.length > 0 ? (
            <div className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-danger">
                <AlertTriangle size={12} /> Guardrail violations
              </div>
              {result.score.guardrailViolations.map((violation, i) => (
                <div key={`${violation.id}-${i}`} className="text-[11px] text-text-secondary">
                  {violation.label} <span className="text-text-muted">(turn {violation.turnIndex})</span>
                  {violation.excerpt ? <span className="text-text-muted"> — “{violation.excerpt}”</span> : null}
                </div>
              ))}
            </div>
          ) : null}

          {/* Findings. */}
          {result.score.findings.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {result.score.findings.map((finding, i) => (
                <li key={i} className="text-[11px] text-text-secondary">• {finding}</li>
              ))}
            </ul>
          ) : null}

          {/* Holistic judge verdict, when a model is wired. */}
          {result.score.judge ? (
            <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[11px] text-text-secondary">
              <span className="font-medium text-text-primary">{result.score.judge.verdict}</span> — {result.score.judge.reasoning}
            </div>
          ) : null}

          {/* Transcript. */}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Transcript</div>
            <div className="flex flex-col gap-2">
              {result.transcript.map((turn) => (
                <div key={turn.index} className="flex flex-col gap-1">
                  <div className="text-[11px] text-text-muted">
                    <span className="font-medium text-text-secondary">Customer:</span> {turn.customer}
                  </div>
                  <div className="rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px] text-text-primary">
                    {turn.error ? <span className="text-danger">[error: {turn.error}]</span> : turn.agent || <span className="text-text-muted">(no reply)</span>}
                  </div>
                  {turn.toolCalls.length > 0 ? (
                    <div className="text-[10px] text-text-muted">tools: {turn.toolCalls.join(', ')}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
