/**
 * MissionControlPage (Agent-Native §3.6) — the cross-agent command center. Three
 * live lenses over the Durable Entity spine: the living/resident agents, the subject
 * pipeline (found → contacted → replied → won), and per-variant experiment success.
 * Not "a stupid UI": real data intelligence — the A/B success bars the operator asked for.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { missionApi, type MissionAgent, type MissionSubject, type MissionExperiment, type MissionSummary } from '../lib/missionApi';
import { apiErrorMessage } from '../lib/api';

const REFRESH_MS = 10_000;

export function MissionControlPage() {
  const [summary, setSummary] = useState<MissionSummary | null>(null);
  const [agents, setAgents] = useState<MissionAgent[]>([]);
  const [subjects, setSubjects] = useState<MissionSubject[]>([]);
  const [byStage, setByStage] = useState<Record<string, number>>({});
  const [experiments, setExperiments] = useState<MissionExperiment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a, sub, exp] = await Promise.all([
        missionApi.summary(), missionApi.agents(), missionApi.subjects(), missionApi.experiments(),
      ]);
      setSummary(s);
      setAgents(a.agents);
      setSubjects(sub.subjects);
      setByStage(sub.byStage);
      setExperiments(exp.experiments);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-4">
        <h1 className="text-display text-text-primary">Mission Control</h1>
        <div className="mt-0.5 text-[12px] text-text-muted">Your living agents, their subjects, and what's working — live.</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-danger">{error}</div>
        )}

        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Resident agents" value={summary?.residentAgents} hint="wake on their own clock" />
          <Kpi label="Subjects" value={summary?.subjects} hint="durable actors on the spine" />
          <Kpi label="Active" value={summary?.activeSubjects} hint="not yet terminal" />
          <Kpi label="Experiments" value={summary?.experiments} hint="A/B in flight" />
        </div>

        {/* Living agents */}
        <Section title="Living agents">
          {agents.length === 0 ? (
            <Empty text="No agents yet. An agent becomes a persistent worker once you enable config.residency." />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((a) => (
                <div key={a.id} className="rounded-lg border border-line bg-surface-2 p-4">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${a.status === 'online' ? 'bg-success' : a.status === 'error' ? 'bg-danger' : 'bg-text-muted'}`} />
                    <span className="truncate text-[14px] font-medium text-text-primary">{a.name}</span>
                    {a.resident && <span className="ml-auto rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">Resident</span>}
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-[12px] text-text-muted">
                    <span>{a.role ?? 'agent'}</span>
                    {a.resident && a.intervalMinutes != null && <span>· wakes every {a.intervalMinutes}m</span>}
                    <span>· {a.grants} connection{a.grants === 1 ? '' : 's'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Subject pipeline */}
        <Section title="Subject pipeline">
          {subjects.length === 0 ? (
            <Empty text="No subjects yet. Enroll one with agentis.subject.enroll — each becomes a durable actor that waits, receives replies out of order, and drives its own lifecycle." />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                {Object.entries(byStage).map(([stage, count]) => (
                  <span key={stage} className="rounded-btn border border-line bg-surface-3 px-3 py-1 text-[12px] text-text-primary">
                    {stage} <span className="text-text-muted">· {count}</span>
                  </span>
                ))}
              </div>
              <div className="overflow-hidden rounded-lg border border-line">
                {subjects.slice(0, 50).map((s, i) => (
                  <div key={s.id} className={`flex items-center gap-3 px-4 py-2.5 text-[13px] ${i > 0 ? 'border-t border-line' : ''}`}>
                    <span className="truncate font-medium text-text-primary">{s.name ?? s.key}</span>
                    <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-text-muted">{s.stage ?? '—'}</span>
                    {s.status === 'done' ? (
                      <span className="ml-auto text-[11px] text-success">done</span>
                    ) : s.parked ? (
                      <span className="ml-auto text-[11px] text-text-muted">waiting…</span>
                    ) : (
                      <span className="ml-auto text-[11px] text-warn">active</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>

        {/* Experiments */}
        <Section title="Experiments — success rate by variant">
          {experiments.length === 0 ? (
            <Empty text="No experiments yet. Define one with agentis.experiment.define, assign subjects, record outcomes — the success % of each variant shows here." />
          ) : (
            <div className="space-y-4">
              {experiments.map((exp) => {
                const best = Math.max(0, ...exp.results.map((r) => r.successRate));
                return (
                  <div key={exp.key} className="rounded-lg border border-line bg-surface-2 p-4">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="text-[13px] font-medium text-text-primary">{exp.key}</span>
                      <span className="text-[11px] text-text-muted">· {exp.status}</span>
                    </div>
                    {exp.results.length === 0 ? (
                      <div className="text-[12px] text-text-muted">No assignments yet.</div>
                    ) : (
                      <div className="space-y-2.5">
                        {exp.results.map((r) => {
                          const pct = Math.round(r.successRate * 100);
                          const isBest = r.successRate === best && r.assigned > 0 && best > 0;
                          return (
                            <div key={r.variant} className="flex items-center gap-3">
                              <span className="w-16 shrink-0 text-[12px] text-text-primary">{r.variant}</span>
                              <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-surface-3">
                                <div
                                  className={`absolute inset-y-0 left-0 rounded-md ${isBest ? 'bg-success' : 'bg-brand'}`}
                                  style={{ width: `${Math.max(2, pct)}%` }}
                                />
                                <span className="absolute inset-y-0 right-2 flex items-center text-[11px] font-medium text-text-primary">{pct}%</span>
                              </div>
                              <span className="w-24 shrink-0 text-right text-[11px] text-text-muted">{r.assigned} assigned</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {!loaded && <div className="py-8 text-center text-[13px] text-text-muted">Loading…</div>}
      </div>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: number | undefined; hint: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-4">
      <div className="text-[26px] font-semibold leading-none text-text-primary">{value ?? '—'}</div>
      <div className="mt-1.5 text-[12px] font-medium text-text-primary">{label}</div>
      <div className="text-[11px] text-text-muted">{hint}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-7">
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{title}</div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12px] text-text-muted">{text}</div>;
}
