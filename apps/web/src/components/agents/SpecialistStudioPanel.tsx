import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, BrainCircuit, CheckCircle2, FlaskConical, Image, Layers3, Loader2, Play, Route, Save, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { apiErrorMessage } from '../../lib/api';
import {
  specialistsApi,
  type SpecialistEvalCase,
  type SpecialistEvalRun,
  type SpecialistLoadoutEntry,
  type SpecialistMind,
  type SpecialistProfile,
  type SpecialistRun,
} from '../../lib/specialists';
import { Button } from '../shared/Button';
import { EmptyState } from '../shared/EmptyState';
import { Skeleton } from '../shared/Skeleton';
import { StatusBadge } from '../shared/StatusBadge';
import { useToast } from '../shared/Toast';

interface SpecialistStudioPanelProps {
  role: string;
  agentId: string;
}

const INPUT_CLS = 'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';
const PANEL = 'rounded-card border border-line bg-surface';

export function SpecialistStudioPanel({ role, agentId }: SpecialistStudioPanelProps) {
  const toast = useToast();
  const [profile, setProfile] = useState<SpecialistProfile | null>(null);
  const [mind, setMind] = useState<SpecialistMind | null>(null);
  const [loadout, setLoadout] = useState<SpecialistLoadoutEntry[]>([]);
  const [abilities, setAbilities] = useState<Array<{ id: string; name: string; description: string | null; compileStatus: string; domainTag: string | null }>>([]);
  const [cases, setCases] = useState<SpecialistEvalCase[]>([]);
  const [evalRuns, setEvalRuns] = useState<SpecialistEvalRun[]>([]);
  const [runs, setRuns] = useState<SpecialistRun[]>([]);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [profileRes, mindRes, abilitiesRes, evalsRes, statusRes, runsRes] = await Promise.all([
        specialistsApi.get(role),
        specialistsApi.mind(role),
        specialistsApi.abilities(role),
        specialistsApi.evals(role),
        specialistsApi.compileStatus(role),
        specialistsApi.runs(role),
      ]);
      setProfile(profileRes.profile);
      setMind(mindRes.mind);
      setLoadout(abilitiesRes.loadout);
      setAbilities(abilitiesRes.abilities);
      setCases(evalsRes.cases);
      setEvalRuns(evalsRes.runs);
      setRuns(runsRes.runs);
      setStatus(statusRes.status);
    } catch (err) {
      toast.error('Could not load Specialist Studio', apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [role, toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const health = useMemo(() => {
    const sourceCount = Number(status?.sourceCount ?? mind?.sources.length ?? 0);
    const atomCount = Number(status?.atomCount ?? mind?.atoms.length ?? 0);
    const loadoutCount = Number(status?.loadoutCount ?? loadout.filter((entry) => entry.enabled).length);
    const evalCaseCount = Number(status?.evalCaseCount ?? cases.length);
    return [
      { label: 'Sources', value: sourceCount },
      { label: 'Atoms', value: atomCount },
      { label: 'Loadout', value: loadoutCount },
      { label: 'Evals', value: evalCaseCount },
    ];
  }, [cases.length, loadout, mind, status]);

  if (loading && !profile) {
    return (
      <div className="space-y-4">
        <Skeleton height={96} />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
          <Skeleton height={520} />
          <Skeleton height={520} />
        </div>
      </div>
    );
  }

  if (!profile || !mind) {
    return (
      <EmptyState
        icon={<BrainCircuit size={40} />}
        title="Specialist profile not ready"
        body="Open this studio after the specialist profile has been created."
      />
    );
  }

  return (
    <div className="space-y-4">
      <header className={`${PANEL} overflow-hidden`}>
        <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={profile.status === 'ready' ? 'online' : 'offline'} label={profile.status} size="sm" />
              <span className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text-muted">{role}</span>
              <span className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted">v{profile.version}</span>
            </div>
            <h2 className="mt-3 text-[24px] font-semibold tracking-tight text-text-primary">Specialist Studio</h2>
            <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-text-secondary">
              Shape this expert's mind, ability DNA, runtime contract, evals, and live routing traces from one place.
            </p>
          </div>
          <div className="border-t border-line bg-surface-2/50 p-4 md:border-l md:border-t-0">
            <div className="grid grid-cols-2 gap-2">
              {health.map((item) => (
                <div key={item.label} className="rounded-md border border-line bg-surface px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-text-muted">{item.label}</div>
                  <div className="mt-1 font-mono text-[20px] text-text-primary">{item.value}</div>
                </div>
              ))}
            </div>
            <Button className="mt-3 w-full" variant="primary" size="sm" iconLeft={<Sparkles size={13} />} onClick={async () => {
              try {
                await specialistsApi.compile(role);
                toast.success('Specialist compiled');
                await refresh();
              } catch (err) {
                toast.error('Compile failed', apiErrorMessage(err));
              }
            }}>
              Compile profile
            </Button>
          </div>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
        <div className="space-y-4">
          <MindLibrary role={role} mind={mind} onChange={refresh} />
          <AbilityLoadout role={role} loadout={loadout} abilities={abilities} onChange={refresh} />
        </div>
        <div className="space-y-4">
          <RuntimeContract role={role} profile={profile} onChange={refresh} />
          <EvalLab role={role} cases={cases} runs={evalRuns} onChange={refresh} />
          <LiveCast role={role} agentId={agentId} runs={runs} onChange={refresh} />
        </div>
      </div>
    </div>
  );
}

function MindLibrary({ role, mind, onChange }: { role: string; mind: SpecialistMind; onChange: () => void }) {
  const toast = useToast();
  const imageRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  async function addText() {
    if (!content.trim()) return;
    setSaving(true);
    try {
      await specialistsApi.addMindSource(role, { kind: 'text', title: title.trim() || 'Operator note', content });
      setTitle('');
      setContent('');
      toast.success('Mind source added');
      onChange();
    } catch (err) {
      toast.error('Could not add source', apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function addImage(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Unsupported file', 'Use PNG, JPG, or WEBP.');
      return;
    }
    const dataUrl = await readAsDataUrl(file);
    try {
      await specialistsApi.addMindSource(role, { kind: 'image', title: file.name, imageBase64: dataUrl, mimeType: file.type, caption: title || undefined });
      toast.success('Image reference added');
      onChange();
    } catch (err) {
      toast.error('Could not add image', apiErrorMessage(err));
    }
  }

  return (
    <section className={PANEL}>
      <PanelHeader icon={<BrainCircuit size={16} />} title="Mind Library" detail={`${mind.sources.length} sources / ${mind.atoms.length} atoms`} />
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(280px,0.7fr)]">
        <div className="space-y-3">
          <input value={title} onChange={(event) => setTitle(event.target.value)} className={INPUT_CLS} placeholder="Source title or image caption" />
          <textarea value={content} onChange={(event) => setContent(event.target.value)} className={`${INPUT_CLS} min-h-[140px] resize-none`} placeholder="Paste rules, examples, visual taste notes, operating constraints, or source excerpts." />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" iconLeft={saving ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} disabled={saving || !content.trim()} onClick={() => void addText()}>
              Add text source
            </Button>
            <Button variant="secondary" size="sm" iconLeft={<Image size={12} />} onClick={() => imageRef.current?.click()}>
              Add image
            </Button>
            <Button variant="ghost" size="sm" iconLeft={<Sparkles size={12} />} onClick={async () => {
              try {
                await specialistsApi.compileMind(role);
                toast.success('Mind compiled');
                onChange();
              } catch (err) {
                toast.error('Mind compile failed', apiErrorMessage(err));
              }
            }}>
              Compile mind
            </Button>
            <input ref={imageRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => {
              void addImage(event.target.files?.[0]);
              event.target.value = '';
            }} />
          </div>
        </div>
        <div className="space-y-2">
          {mind.atoms.length === 0 ? (
            <div className="rounded-md border border-dashed border-line px-4 py-5 text-[13px] text-text-muted">
              Add sources to distill facts, rules, examples, and visual patterns.
            </div>
          ) : (
            mind.atoms.slice(0, 6).map((atom) => (
              <div key={atom.id} className="rounded-md border border-line bg-surface-2 px-3 py-2">
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded-pill bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">{atom.atomType.replace(/_/g, ' ')}</span>
                  <span className="font-mono text-[10px] text-text-muted">{Math.round(atom.confidence * 100)}%</span>
                </div>
                <p className="line-clamp-3 text-[12px] leading-snug text-text-secondary">{atom.content}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function AbilityLoadout({ role, loadout, abilities, onChange }: { role: string; loadout: SpecialistLoadoutEntry[]; abilities: Array<{ id: string; name: string; description: string | null; compileStatus: string; domainTag: string | null }>; onChange: () => void }) {
  const toast = useToast();
  const byAbility = new Map(loadout.map((entry) => [entry.abilityId, entry]));
  async function setMode(abilityId: string, mode: SpecialistLoadoutEntry['mode']) {
    try {
      await specialistsApi.setAbility(role, abilityId, { mode, priority: mode === 'required' ? 10 : mode === 'forbidden' ? -10 : 0, enabled: true });
      onChange();
    } catch (err) {
      toast.error('Could not update loadout', apiErrorMessage(err));
    }
  }
  return (
    <section className={PANEL}>
      <PanelHeader icon={<Layers3 size={16} />} title="Ability Loadout" detail={`${loadout.filter((entry) => entry.enabled).length} active`} />
      <div className="divide-y divide-line">
        {abilities.length === 0 ? (
          <div className="p-4 text-[13px] text-text-muted">No compiled abilities exist in this workspace yet.</div>
        ) : abilities.slice(0, 10).map((ability) => {
          const entry = byAbility.get(ability.id);
          return (
            <div key={ability.id} className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-text-primary">{ability.name}</span>
                  <StatusBadge status={ability.compileStatus === 'ready' ? 'online' : 'offline'} label={entry?.mode ?? 'semantic'} size="sm" />
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-text-muted">{ability.description || ability.domainTag || 'Workspace ability'}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {(['required', 'preferred', 'optional', 'forbidden'] as const).map((mode) => (
                  <button key={mode} type="button" onClick={() => void setMode(ability.id, mode)} className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${entry?.mode === mode ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface-2 text-text-muted hover:text-text-primary'}`}>
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RuntimeContract({ role, profile, onChange }: { role: string; profile: SpecialistProfile; onChange: () => void }) {
  const toast = useToast();
  const runtime = profile.runtimeProfile ?? {};
  const [modelPolicy, setModelPolicy] = useState(String(runtime.modelPolicy ?? 'default'));
  const [autonomyLevel, setAutonomyLevel] = useState(String(runtime.autonomyLevel ?? 'act_with_approval'));
  const [sessionPolicy, setSessionPolicy] = useState(String(runtime.sessionPolicy ?? 'stateless'));
  useEffect(() => {
    setModelPolicy(String(profile.runtimeProfile?.modelPolicy ?? 'default'));
    setAutonomyLevel(String(profile.runtimeProfile?.autonomyLevel ?? 'act_with_approval'));
    setSessionPolicy(String(profile.runtimeProfile?.sessionPolicy ?? 'stateless'));
  }, [profile]);
  return (
    <section className={PANEL}>
      <PanelHeader icon={<ShieldCheck size={16} />} title="Runtime Contract" detail={profile.status} />
      <div className="space-y-3 p-4">
        <Field label="Model policy">
          <select value={modelPolicy} onChange={(event) => setModelPolicy(event.target.value)} className={INPUT_CLS}>
            {['default', 'cheap', 'deep_reasoning', 'vision', 'local'].map((item) => <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <Field label="Autonomy">
          <select value={autonomyLevel} onChange={(event) => setAutonomyLevel(event.target.value)} className={INPUT_CLS}>
            {['advise', 'draft', 'act_with_approval', 'autonomous_limited'].map((item) => <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <Field label="Session policy">
          <select value={sessionPolicy} onChange={(event) => setSessionPolicy(event.target.value)} className={INPUT_CLS}>
            {['stateless', 'persistent', 'per_workflow', 'per_user'].map((item) => <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <Button variant="primary" size="sm" iconLeft={<Save size={12} />} onClick={async () => {
          try {
            await specialistsApi.patch(role, { runtimeProfile: { ...profile.runtimeProfile, modelPolicy, autonomyLevel, sessionPolicy } });
            toast.success('Runtime contract saved');
            onChange();
          } catch (err) {
            toast.error('Save failed', apiErrorMessage(err));
          }
        }}>
          Save contract
        </Button>
      </div>
    </section>
  );
}

function EvalLab({ role, cases, runs, onChange }: { role: string; cases: SpecialistEvalCase[]; runs: SpecialistEvalRun[]; onChange: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [input, setInput] = useState('');
  const runByCase = new Map(runs.map((run) => [run.evalCaseId, run]));
  return (
    <section className={PANEL}>
      <PanelHeader icon={<FlaskConical size={16} />} title="Eval Lab" detail={`${cases.length} cases`} />
      <div className="space-y-3 p-4">
        <div className="grid gap-2">
          <input value={name} onChange={(event) => setName(event.target.value)} className={INPUT_CLS} placeholder="Eval case name" />
          <textarea value={input} onChange={(event) => setInput(event.target.value)} className={`${INPUT_CLS} min-h-[84px] resize-none`} placeholder="Task input and acceptance rubric." />
          <Button variant="secondary" size="sm" iconLeft={<FlaskConical size={12} />} disabled={!name.trim() || !input.trim()} onClick={async () => {
            try {
              await specialistsApi.addEvalCase(role, { name, input, expected: input });
              setName('');
              setInput('');
              onChange();
            } catch (err) {
              toast.error('Could not add eval', apiErrorMessage(err));
            }
          }}>
            Add eval case
          </Button>
        </div>
        <div className="space-y-2">
          {cases.slice(0, 5).map((item) => {
            const latest = runByCase.get(item.id);
            return (
              <div key={item.id} className="rounded-md border border-line bg-surface-2 p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-text-primary">{item.name}</div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-text-muted">{item.input}</p>
                  </div>
                  {latest && <span className="font-mono text-[12px] text-text-secondary">{Math.round(latest.score * 100)}%</span>}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button variant="ghost" size="sm" iconLeft={<Play size={11} />} onClick={async () => {
                    try {
                      await specialistsApi.runEval(role, item.id);
                      onChange();
                    } catch (err) {
                      toast.error('Eval failed', apiErrorMessage(err));
                    }
                  }}>
                    Run
                  </Button>
                  {latest && !latest.promotedAtomId && (
                    <Button variant="ghost" size="sm" iconLeft={<CheckCircle2 size={11} />} onClick={async () => {
                      try {
                        await specialistsApi.promoteEval(role, latest.id);
                        toast.success('Promoted to mind');
                        onChange();
                      } catch (err) {
                        toast.error('Promotion failed', apiErrorMessage(err));
                      }
                    }}>
                      Promote
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function LiveCast({ role, agentId, runs, onChange }: { role: string; agentId: string; runs: SpecialistRun[]; onChange: () => void }) {
  const toast = useToast();
  const [task, setTask] = useState('');
  const [latest, setLatest] = useState<string | null>(null);
  return (
    <section className={PANEL}>
      <PanelHeader icon={<Activity size={16} />} title="Live Cast" detail={agentId.slice(0, 8)} />
      <div className="space-y-3 p-4">
        <textarea value={task} onChange={(event) => setTask(event.target.value)} className={`${INPUT_CLS} min-h-[90px] resize-none`} placeholder="Ask the router for the best specialist for a task." />
        <Button variant="primary" size="sm" iconLeft={<Route size={12} />} disabled={!task.trim()} onClick={async () => {
          try {
            const result = await specialistsApi.request({ task, materialize: true });
            setLatest(result.route.explanation);
            setTask('');
            onChange();
          } catch (err) {
            toast.error('Routing failed', apiErrorMessage(err));
          }
        }}>
          Route request
        </Button>
        {latest && <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] leading-snug text-text-secondary">{latest}</div>}
        <div className="space-y-2">
          {runs.length === 0 ? (
            <div className="rounded-md border border-dashed border-line px-3 py-4 text-[12px] text-text-muted">Specialist run traces will appear here.</div>
          ) : runs.slice(0, 4).map((run) => (
            <div key={run.id} className="rounded-md border border-line bg-surface-2 p-3">
              <div className="flex items-center gap-2">
                <StatusBadge status={run.status === 'planned' ? 'offline' : 'online'} label={run.status} size="sm" />
                <span className="font-mono text-[11px] text-text-muted">{run.topology}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-[12px] text-text-secondary">{run.task}</p>
              {run.trace[0] && <p className="mt-2 text-[11px] text-text-muted">{run.trace[0].summary}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PanelHeader({ icon, title, detail }: { icon: ReactNode; title: string; detail?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-3">
      <span className="text-text-muted">{icon}</span>
      <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
      {detail && <span className="ml-auto truncate text-[11px] text-text-muted">{detail}</span>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}
