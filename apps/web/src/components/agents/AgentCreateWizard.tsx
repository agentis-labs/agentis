import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import {
  DEFAULT_RUNTIME_CONFIG,
  RuntimePicker,
  runtimeConfigToAdapterConfig,
  runtimeModelFor,
  type AdapterType,
  type HarnessDetectionResult,
  type RuntimeConfig,
} from './RuntimePicker';
import { PlaybookLibrary, type PlaybookEntry } from './PlaybookLibrary';
import { ManagerGlyph, OrchestratorGlyph, WorkerGlyph } from './AgentRoleGlyphs';
type AgentRole = 'orchestrator' | 'manager' | 'worker';
type ChannelKind = 'telegram' | 'discord';
type GlyphComponent = (props: { size?: number }) => JSX.Element;

interface Space {
  id: string;
  name: string;
  colorHex?: string;
  color?: string;
}

interface ExistingAgent {
  id: string;
  name: string;
  role?: AgentRole | null;
  spaceId?: string | null;
}

interface PlaybookResponse {
  entries: PlaybookEntry[];
}

interface DetectResponse {
  adapters?: HarnessDetectionResult[];
  harnesses?: HarnessDetectionResult[];
}

interface HarnessCheck {
  code?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string;
  hint?: string;
}

interface HarnessTestResult {
  status: 'pass' | 'warn' | 'fail';
  checks: HarnessCheck[];
}

interface ChannelDraft {
  kind: ChannelKind;
  open: boolean;
  token: string;
  defaultChatId: string;
}

interface AgentCreateWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: { id: string; name: string }) => void;
  initialRole?: AgentRole | null;
  initialSpaceId?: string | null;
  lockInitialRole?: boolean;
  flipFrom?: unknown;
  heading?: string;
  intro?: string;
}

const EMPTY_DETECTIONS: HarnessDetectionResult[] = [];
const EMPTY_PLAYBOOKS: PlaybookEntry[] = [];
const DEFAULT_CHANNELS: Record<ChannelKind, ChannelDraft> = {
  telegram: { kind: 'telegram', open: false, token: '', defaultChatId: '' },
  discord: { kind: 'discord', open: false, token: '', defaultChatId: '' },
};

const ROLE_COLOR: Record<AgentRole, string> = {
  orchestrator: '#8b5cf6',
  manager: '#06b6d4',
  worker: '#60a5fa',
};

const ROLE_OPTIONS: Array<{
  value: AgentRole;
  title: string;
  subtitle: string;
  icon: GlyphComponent;
}> = [
  {
    value: 'orchestrator',
    title: 'Orchestrator',
    subtitle: 'The workspace brain. Routes goals, managers, and workers.',
    icon: OrchestratorGlyph,
  },
  {
    value: 'manager',
    title: 'Manager',
    subtitle: 'Owns a domain or space. Coordinates execution under the brain.',
    icon: ManagerGlyph,
  },
  {
    value: 'worker',
    title: 'Worker',
    subtitle: 'Executes tasks. Specializes in one operating lane.',
    icon: WorkerGlyph,
  },
];

function initials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

function defaultNameForRole(role: AgentRole): string {
  if (role === 'orchestrator') return 'The Brain';
  if (role === 'manager') return 'Department Manager';
  return 'Specialist Worker';
}

function roleSummary(role: AgentRole): string {
  if (role === 'orchestrator') return 'Workspace brain';
  if (role === 'manager') return 'Manager';
  return 'Worker';
}

function renderTemplate(markdown: string, name: string): string {
  return markdown.replaceAll('{{name}}', name || 'The Brain');
}

function playbookRoles(entry: PlaybookEntry): AgentRole[] | undefined {
  if (!('roles' in entry)) return undefined;
  return (entry as PlaybookEntry & { roles?: AgentRole[] }).roles;
}

function filterPlaybooks(entries: PlaybookEntry[], role: AgentRole): PlaybookEntry[] {
  const filtered = entries.filter((entry) => {
    const roles = playbookRoles(entry);
    return !roles || roles.includes(role);
  });
  return filtered.length > 0 ? filtered : entries;
}

function cloneChannels(): Record<ChannelKind, ChannelDraft> {
  return {
    telegram: { ...DEFAULT_CHANNELS.telegram },
    discord: { ...DEFAULT_CHANNELS.discord },
  };
}

function labelForSupervisor(agents: ExistingAgent[], id: string): string {
  return agents.find((agent) => agent.id === id)?.name ?? 'Unassigned';
}

function runtimeLabel(adapterType: AdapterType): string {
  if (adapterType === 'claude_code') return 'Claude Code';
  if (adapterType === 'codex') return 'Codex';
  if (adapterType === 'cursor') return 'Cursor';
  if (adapterType === 'hermes_agent') return 'Hermes Agent';
  if (adapterType === 'openclaw') return 'OpenClaw';
  return 'HTTP';
}

function inboxSummary(channels: Record<ChannelKind, ChannelDraft>): string {
  const active = Object.values(channels)
    .filter((channel) => channel.token.trim())
    .map((channel) => channel.kind);

  if (active.length === 0) return 'None';
  return active.join(', ');
}

function budgetToCents(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

export function AgentCreateWizard({
  open,
  onClose,
  onCreated,
  initialRole,
  initialSpaceId,
  lockInitialRole = false,
  flipFrom,
  heading,
  intro,
}: AgentCreateWizardProps) {
  const toast = useToast();
  const seededRoleRef = useRef<AgentRole | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [role, setRole] = useState<AgentRole>(initialRole ?? 'worker');
  const [reportsTo, setReportsTo] = useState('');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [agents, setAgents] = useState<ExistingAgent[]>([]);
  const [detections, setDetections] = useState<HarnessDetectionResult[]>(EMPTY_DETECTIONS);
  const [detecting, setDetecting] = useState(false);
  const [playbookEntries, setPlaybookEntries] = useState<PlaybookEntry[]>(EMPTY_PLAYBOOKS);
  const [adapterType, setAdapterType] = useState<AdapterType>('claude_code');
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(DEFAULT_RUNTIME_CONFIG);
  const [playbook, setPlaybook] = useState('');
  const [capabilityTags, setCapabilityTags] = useState<string[]>([]);
  const [monthlyBudget, setMonthlyBudget] = useState('500');
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [channels, setChannels] = useState<Record<ChannelKind, ChannelDraft>>(cloneChannels());
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<HarnessTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const orchestrator = useMemo(() => agents.find((agent) => agent.role === 'orchestrator') ?? null, [agents]);
  const managers = useMemo(() => agents.filter((agent) => agent.role === 'manager'), [agents]);
  const detectionsByType = useMemo(() => new Map(detections.map((detection) => [detection.adapterType, detection])), [detections]);
  const activeDetection = detectionsByType.get(adapterType);
  const visiblePlaybooks = useMemo(() => filterPlaybooks(playbookEntries, role), [playbookEntries, role]);
  const supervisorOptions = useMemo(() => {
    if (role === 'manager') return orchestrator ? [orchestrator] : [];
    if (role === 'worker') return [...managers, ...(orchestrator ? [orchestrator] : [])];
    return [] as ExistingAgent[];
  }, [managers, orchestrator, role]);

  useEffect(() => {
    if (!open) return;

    const nextRole = initialRole ?? 'worker';
    setName(nextRole === 'orchestrator' ? 'The Brain' : '');
    setDescription('');
    setSpaceId(initialSpaceId ?? '');
    setRole(nextRole);
    setReportsTo('');
    setDetections(EMPTY_DETECTIONS);
    setDetecting(true);
    setPlaybookEntries(EMPTY_PLAYBOOKS);
    setAdapterType('claude_code');
    setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
    setPlaybook('');
    setCapabilityTags([]);
    setMonthlyBudget('500');
    setChannelsOpen(false);
    setChannels(cloneChannels());
    setTesting(false);
    setTestResult(null);
    setTestError(null);
    seededRoleRef.current = null;

    void Promise.allSettled([
      api<{ spaces: Space[] }>('/v1/spaces'),
      api<{ agents: ExistingAgent[] }>('/v1/agents'),
      api<DetectResponse>('/v1/harness/detect'),
      api<PlaybookResponse>('/v1/agents/playbook-library'),
    ]).then(([spacesResult, agentsResult, detectResult, playbookResult]) => {
      setSpaces(spacesResult.status === 'fulfilled' ? spacesResult.value.spaces ?? [] : []);
      const loadedAgents = agentsResult.status === 'fulfilled' ? agentsResult.value.agents ?? [] : [];
      setAgents(loadedAgents);
      const existingOrchestrator = loadedAgents.find((agent) => agent.role === 'orchestrator');
      if (nextRole === 'manager' && existingOrchestrator) {
        setReportsTo(existingOrchestrator.id);
      }
      if (nextRole === 'worker') {
        const workerSupervisor = loadedAgents.find((agent) => agent.role === 'manager') ?? existingOrchestrator;
        if (workerSupervisor) setReportsTo(workerSupervisor.id);
      }

      if (detectResult.status === 'fulfilled') {
        setDetections(detectResult.value.adapters ?? detectResult.value.harnesses ?? []);
      } else {
        setDetections([]);
      }

      setDetecting(false);
      setPlaybookEntries(playbookResult.status === 'fulfilled' ? playbookResult.value.entries ?? [] : []);
    });
  }, [initialRole, initialSpaceId, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (role === 'orchestrator') {
      setReportsTo('');
      if (!name.trim()) setName('The Brain');
      return;
    }

    if (reportsTo) return;
    if (role === 'manager' && orchestrator) {
      setReportsTo(orchestrator.id);
      return;
    }
    if (role === 'worker') {
      const workerSupervisor = managers[0] ?? orchestrator;
      if (workerSupervisor) setReportsTo(workerSupervisor.id);
    }
  }, [managers, name, orchestrator, reportsTo, role]);

  useEffect(() => {
    if (!open || visiblePlaybooks.length === 0) return;
    if (seededRoleRef.current === role && playbook.trim()) return;
    const preferred = visiblePlaybooks[0];
    if (!preferred) return;
    setPlaybook(renderTemplate(preferred.markdown, name.trim() || defaultNameForRole(role)));
    setCapabilityTags(preferred.suggestedTags ?? []);
    seededRoleRef.current = role;
  }, [name, open, playbook, role, visiblePlaybooks]);

  if (!open) return null;

  async function refreshDetections() {
    setDetecting(true);
    try {
      const response = await api<DetectResponse>('/v1/harness/detect');
      setDetections(response.adapters ?? response.harnesses ?? []);
    } catch {
      setDetections([]);
    } finally {
      setDetecting(false);
    }
  }

  function updateChannel(kind: ChannelKind, patch: Partial<ChannelDraft>) {
    setChannels((current) => ({
      ...current,
      [kind]: { ...current[kind], ...patch },
    }));
  }

  function pickTemplate(entry: PlaybookEntry) {
    setPlaybook(renderTemplate(entry.markdown, name.trim() || defaultNameForRole(role)));
    setCapabilityTags(entry.suggestedTags ?? []);
    seededRoleRef.current = role;
  }

  async function handleCreate() {
    if (!name.trim()) return;

    setCreating(true);
    try {
      const needsRuntimeSetup = adapterType !== 'http' && activeDetection?.status !== 'found';
      const adapterConfig = runtimeConfigToAdapterConfig(adapterType, runtimeConfig);
      const runtimeModel = runtimeModelFor(adapterType, runtimeConfig);

      const created = await api<{ agent: { id: string; name: string } }>('/v1/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          spaceId: role === 'orchestrator' ? undefined : (spaceId || undefined),
          role,
          reportsTo: role === 'orchestrator' ? null : reportsTo || null,
          avatarGlyph: initials(name.trim()),
          colorHex: ROLE_COLOR[role],
          adapterType,
          runtimeModel,
          capabilityTags,
          instructions: playbook,
          monthlyBudgetCents: budgetToCents(monthlyBudget),
          config: adapterConfig,
          ...(needsRuntimeSetup ? { status: 'setting_up' } : {}),
        }),
      });

      const channelErrors: string[] = [];
      if (role === 'orchestrator') {
        for (const channel of Object.values(channels)) {
          if (!channel.token.trim()) continue;
          try {
            await api('/v1/channels', {
              method: 'POST',
              body: JSON.stringify({
                kind: channel.kind,
                name: `${name.trim()} ${channel.kind}`,
                agentId: created.agent.id,
                token: channel.token.trim(),
                defaultChatId: channel.defaultChatId.trim() || undefined,
              }),
            });
          } catch (channelError) {
            channelErrors.push(`${channel.kind}: ${apiErrorMessage(channelError)}`);
          }
        }
      }

      if (needsRuntimeSetup) {
        toast.success(
          'Agent commissioned — runtime setup pending',
          `${name.trim()} is ready to connect once the runtime is available.`,
        );
      } else {
        toast.success('Agent commissioned', name.trim());
      }

      if (channelErrors.length > 0) {
        toast.error('Some inbox channels were not saved', channelErrors.join(' | '));
      }
      onCreated(created.agent);
    } catch (error) {
      toast.error('Could not commission agent', apiErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function handleTestRuntime() {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const config = runtimeConfigToAdapterConfig(adapterType, runtimeConfig);
      const result = await api<HarnessTestResult>('/v1/harness/test', {
        method: 'POST',
        body: JSON.stringify({ adapterType, config }),
      });
      setTestResult(result);
    } catch (error) {
      setTestError(apiErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  const canCreate = name.trim().length >= 2 && !(role === 'orchestrator' && Boolean(orchestrator));

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-black/30" role="dialog" aria-modal="true">
      <aside className="flex h-full w-full max-w-[620px] animate-slide-in-right flex-col border-l border-line bg-surface shadow-modal">
        <header className="border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-heading text-text-primary">{heading ?? 'Commission agent'}</h2>
              <div className="mt-1 text-xs text-text-muted">Name it, give it a runtime, commission it.</div>
              {intro ? <p className="mt-2 max-w-[44rem] text-[12px] leading-relaxed text-text-muted">{intro}</p> : null}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
              <X size={16} />
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-6">
            <div className="space-y-5">
              <section className="space-y-3">
                <div className="flex items-center gap-4">
                  <div
                    className="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-surface-2 text-base font-bold text-text-primary"
                    style={{ boxShadow: `0 0 0 4px ${ROLE_COLOR[role]}22` }}
                  >
                    {initials(name)}
                  </div>
                  <label className="min-w-0 flex-1">
                    <span className="text-xs font-medium text-text-secondary">Name</span>
                    <input
                      autoFocus
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={role === 'orchestrator' ? 'The Brain' : 'e.g. Research lead'}
                      className={inputCls}
                    />
                  </label>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-text-secondary">Description</span>
                  <input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={160}
                    placeholder="What does this agent do?"
                    className={inputCls}
                  />
                </label>

                {role !== 'orchestrator' && (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-text-secondary">Space</span>
                    <select value={spaceId} onChange={(event) => setSpaceId(event.target.value)} className={inputCls}>
                      <option value="">No space</option>
                      {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
                    </select>
                  </label>
                )}
              </section>

              <section className="space-y-2">
                <span className="text-xs font-medium text-text-secondary">Role</span>
                <div className="flex flex-wrap gap-2">
                  {ROLE_OPTIONS.map((option) => {
                    const GlyphIcon = option.icon;
                    const selected = role === option.value;
                    const blocked = option.value === 'orchestrator' && Boolean(orchestrator) && option.value !== role;
                    const disabled = (lockInitialRole && option.value !== role) || blocked;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        disabled={disabled}
                        onClick={() => setRole(option.value)}
                        title={blocked ? `An orchestrator already exists: ${orchestrator?.name}` : option.subtitle}
                        className={clsx(
                          'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
                          selected ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface-2 text-text-secondary hover:border-accent/40 hover:text-text-primary',
                          disabled && 'cursor-not-allowed opacity-40',
                        )}
                      >
                        <GlyphIcon size={11} />
                        {option.title}
                        {blocked && <span className="text-[10px] text-text-muted">(exists)</span>}
                      </button>
                    );
                  })}
                </div>
                {role !== 'orchestrator' && (
                  <p className="text-[11px] text-text-muted">{ROLE_OPTIONS.find((o) => o.value === role)?.subtitle}</p>
                )}
              </section>

              <HierarchyNotice
                role={role}
                orchestrator={orchestrator}
                reportsTo={reportsTo}
                supervisors={supervisorOptions}
                onReportsToChange={setReportsTo}
                onBecomeOrchestrator={() => {
                  if (!lockInitialRole) setRole('orchestrator');
                }}
              />

              {role === 'orchestrator' && (
                <section className="rounded-lg border border-line bg-surface-2">
                  <button
                    type="button"
                    onClick={() => setChannelsOpen((value) => !value)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-text-secondary hover:text-text-primary"
                  >
                    <span>Connect your inbox</span>
                    <span className="text-text-muted">{channelsOpen ? 'Hide' : 'Optional'}</span>
                  </button>
                  {channelsOpen && (
                    <div className="space-y-3 border-t border-line p-3">
                      <InboxChannelCard
                        draft={channels.telegram}
                        title="Telegram"
                        chatLabel="Default chat ID"
                        help="Bot token from BotFather. Chat ID can be a user or chat target."
                        onToggle={() => updateChannel('telegram', { open: !channels.telegram.open })}
                        onTokenChange={(value) => updateChannel('telegram', { token: value })}
                        onChatChange={(value) => updateChannel('telegram', { defaultChatId: value })}
                      />
                      <InboxChannelCard
                        draft={channels.discord}
                        title="Discord"
                        chatLabel="Default channel ID"
                        help="Bot token plus a Discord channel ID."
                        onToggle={() => updateChannel('discord', { open: !channels.discord.open })}
                        onTokenChange={(value) => updateChannel('discord', { token: value })}
                        onChatChange={(value) => updateChannel('discord', { defaultChatId: value })}
                      />
                    </div>
                  )}
                </section>
              )}
            </div>

            <section className="space-y-3 border-t border-line pt-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-text-secondary">Runtime</span>
                <button
                  type="button"
                  onClick={() => void handleTestRuntime()}
                  disabled={testing}
                  className={secondaryBtnCls}
                >
                  {testing ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  {testing ? 'Testing runtime…' : 'Test runtime'}
                </button>
              </div>

              <RuntimePicker
                adapterType={adapterType}
                runtimeConfig={runtimeConfig}
                onAdapterChange={(value) => { setAdapterType(value); setTestResult(null); setTestError(null); }}
                onConfigChange={setRuntimeConfig}
                detections={detections}
                detecting={detecting}
                onRefreshDetections={refreshDetections}
              />

              <RuntimeTestReport testing={testing} result={testResult} error={testError} />
            </section>
          </div>
        </main>

        <footer className="flex items-center justify-between gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button type="button" onClick={onClose} className={secondaryBtnCls}>Cancel</button>
          <button type="button" disabled={creating || !canCreate} onClick={() => void handleCreate()} className={primaryBtnCls}>
            {creating ? 'Commissioning…' : 'Commission agent'}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function RuntimeTestReport({
  testing,
  result,
  error,
}: {
  testing: boolean;
  result: HarnessTestResult | null;
  error: string | null;
}) {
  if (testing) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs text-text-muted">
        <Loader2 size={13} className="animate-spin" />
        Running a live runtime probe — this can take up to 45 seconds.
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger">
        Could not run the runtime test: {error}
      </div>
    );
  }

  if (!result) return null;

  const summary = result.status === 'pass'
    ? 'Runtime is live and ready'
    : result.status === 'warn'
      ? 'Runtime works with warnings'
      : 'Runtime is not ready';
  const summaryCls = result.status === 'pass'
    ? 'border-accent/30 bg-accent/10 text-text-primary'
    : result.status === 'warn'
      ? 'border-amber-500/30 bg-amber-500/5 text-text-primary'
      : 'border-danger/30 bg-danger/5 text-text-primary';

  return (
    <div className={clsx('space-y-2 rounded-lg border px-3 py-3', summaryCls)}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <CheckGlyph level={result.status === 'pass' ? 'info' : result.status === 'warn' ? 'warn' : 'error'} />
        {summary}
      </div>
      <ul className="space-y-1.5">
        {result.checks.map((check, index) => (
          <li key={`${check.code ?? 'check'}-${index}`} className="flex gap-2 text-[12px] leading-relaxed">
            <span className="mt-0.5 shrink-0"><CheckGlyph level={check.level} /></span>
            <span className="min-w-0 text-text-secondary">
              <span className="text-text-primary">{check.message}</span>
              {check.detail ? <span className="text-text-muted"> — {check.detail}</span> : null}
              {check.hint ? <span className="mt-0.5 block text-text-muted">↳ {check.hint}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CheckGlyph({ level }: { level: 'info' | 'warn' | 'error' }) {
  if (level === 'error') return <AlertTriangle size={13} className="text-danger" />;
  if (level === 'warn') return <AlertTriangle size={13} className="text-amber-500" />;
  return <Check size={13} className="text-accent" />;
}

function HierarchyNotice({
  role,
  orchestrator,
  reportsTo,
  supervisors,
  onReportsToChange,
  onBecomeOrchestrator,
}: {
  role: AgentRole;
  orchestrator: ExistingAgent | null;
  reportsTo: string;
  supervisors: ExistingAgent[];
  onReportsToChange: (value: string) => void;
  onBecomeOrchestrator: () => void;
}) {
  if (role === 'orchestrator') {
    return (
      <div className={clsx('rounded-lg border px-3 py-3 text-sm', orchestrator ? 'border-danger/30 bg-danger/5 text-danger' : 'border-line bg-surface-2 text-text-muted')}>
        {orchestrator
          ? `A workspace brain already exists: ${orchestrator.name}. Commission this agent as a manager or worker instead.`
          : 'This agent will be the workspace brain. One orchestrator per workspace.'}
      </div>
    );
  }

  if (role === 'manager' && !orchestrator) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-sm text-text-muted">
        Managers need a workspace brain to report to.
        <button type="button" onClick={onBecomeOrchestrator} className="ml-2 text-accent hover:underline">Commission orchestrator instead</button>
      </div>
    );
  }

  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-text-secondary">{role === 'manager' ? 'Reports to' : 'Supervised by'}</span>
      <select value={reportsTo} onChange={(event) => onReportsToChange(event.target.value)} className={inputCls}>
        <option value="">{role === 'manager' ? 'No brain selected' : 'No supervisor selected'}</option>
        {supervisors.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.role ? ` - ${agent.role}` : ''}</option>)}
      </select>
    </label>
  );
}

function InboxChannelCard({
  draft,
  title,
  chatLabel,
  help,
  onToggle,
  onTokenChange,
  onChatChange,
}: {
  draft: ChannelDraft;
  title: string;
  chatLabel: string;
  help: string;
  onToggle: () => void;
  onTokenChange: (value: string) => void;
  onChatChange: (value: string) => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-canvas">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-text-primary">
        <span>{title}</span>
        <span className="text-[11px] text-text-muted">{draft.token.trim() ? 'Configured' : 'Not set'}</span>
      </button>

      {draft.open && (
        <div className="space-y-3 border-t border-line p-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Token</span>
            <input
              type="password"
              value={draft.token}
              onChange={(event) => onTokenChange(event.target.value)}
              placeholder="Paste token"
              className={inputCls}
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{chatLabel}</span>
            <input
              value={draft.defaultChatId}
              onChange={(event) => onChatChange(event.target.value)}
              placeholder="Target ID"
              className={inputCls}
            />
          </label>

          <div className="text-[11px] text-text-muted">{help}</div>
        </div>
      )}
    </div>
  );
}

const inputCls = 'mt-1 h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent';
const secondaryBtnCls = 'inline-flex h-9 items-center gap-1.5 rounded-btn border border-line px-3 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary';
const primaryBtnCls = 'inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40';
