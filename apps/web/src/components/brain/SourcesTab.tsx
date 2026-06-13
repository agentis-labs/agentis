/**
 * Sources — the Workspace Brain's setup and continuity-control surface
 * (RFC §14.4). Backed by the /v1/cora engine; the word "CORA" never appears
 * in this UI (Scheme A naming).
 *
 * Two states:
 *  1. Quickstart (first run): three moments — intent → detected operating
 *     surface → launch. Detection first, presets over blank forms, no
 *     infrastructure vocabulary (RFC §14.6–§14.7).
 *  2. Control room: learning-plan health, source cards, per-agent access
 *     modes, claims/conflicts summary, identity review, and migration
 *     opportunities. Answers: "What is the Brain learning, from where, under
 *     which rules, and what needs my decision?"
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowRight, Bot, Check, CheckCircle2, ChevronRight,
  CircleDashed, Eye, GitMerge, Loader2, Lock, Pause, Play, Plug, Plus, RefreshCw,
  Scale, ShieldCheck, Sparkles, Webhook, Workflow, X,
} from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';

// ── API shapes (mirror apps/api/src/cora) ────────────────────

interface OwnerProfile {
  id: string;
  name: string | null;
  intent: string | null;
  operatingShape: string;
  charter: string | null;
  onboardingState: 'pending' | 'discovered' | 'previewed' | 'launched';
}

interface LearningPlanStage {
  kind: string;
  mode: string;
  status: 'pending' | 'running' | 'healthy' | 'attention' | 'paused';
}

interface LearningPlan {
  id: string;
  stagesJson: LearningPlanStage[];
  reasoningMode: string;
  status: string;
}

interface SourceCandidate {
  sourceType: string;
  displayName: string;
  connectionId?: string;
  state: 'ready' | 'connect' | 'suggested_later' | 'needs_attention';
  reason: string;
  requiresOwnerAction: boolean;
}

interface DiscoveryResult {
  inferredName?: string;
  inferredCharter?: string;
  detectedSources: SourceCandidate[];
  suggestedDomains: string[];
  suggestedAgentGrants: Array<{ agentId: string; agentName: string; mode: string; reason: string }>;
}

interface SourceConnection {
  id: string;
  sourceType: string;
  displayName: string;
  status: string;
  reasoningMode: string;
  lastSyncAt: string | null;
  healthJson: { ok?: boolean; lastOutcome?: string };
}

interface RegisteredSource {
  sourceType: string;
  displayName: string;
  capabilities: { supportsWebhooks: boolean; supportsBackfill: boolean; supportsDeletes: boolean; supportsIdentityDirectory: boolean };
}

interface CredentialRow {
  id: string;
  name: string;
  credentialType: string;
}

interface DiscoveredScope {
  id: string;
  label: string;
  kind: string;
  recommended: boolean;
}

const BRIEF_PURPOSES = ['operations', 'customers', 'product', 'engineering', 'marketing', 'finance', 'research', 'personal'] as const;

interface OAuthProvider {
  id: string;
  label: string;
  configured: boolean;
}

/**
 * Which one-click OAuth provider authenticates each Brain source, and the
 * read-sync slug (RFC §7.6 / docs/OAUTH-STRATEGY.md). The server validates
 * provider↔slug and scopes; this is just which "Sign in with X" to offer.
 */
const SOURCE_OAUTH: Record<string, { providerId: string; slug: string; label: string }> = {
  slack: { providerId: 'slack', slug: 'brain_slack', label: 'Slack' },
  google_drive: { providerId: 'google', slug: 'brain_google_drive', label: 'Google' },
  github: { providerId: 'github', slug: 'brain_github', label: 'GitHub' },
};

interface ClaimRow {
  id: string;
  predicate: string;
  status: string;
  confidence: number;
  claimType: string;
  protectedDomain: boolean;
}

interface ConflictRow {
  id: string;
  claimIdsJson: string[];
  consequentiality: string;
  resolution: string;
}

interface IdentityLinkRow {
  id: string;
  method: string;
  confidence: number;
}

interface MigrationRow {
  id: string;
  title: string;
  status: string;
  recurrence: number;
  recommendedTarget: string;
  expectedValue: number;
}

interface AccessRequestRow {
  id: string;
  agentId: string;
  purpose: string;
  createdAt: string;
}

interface InvestigationRow {
  id: string;
  question: string;
  status: string;
  grounding: number;
  explanation: string | null;
  gapsJson: string[];
}

interface AgentRow {
  id: string;
  name: string;
  role?: string | null;
}

interface AgentGrant {
  agentId: string;
  mode: 'none' | 'full_delegated' | 'agent_decides' | 'human_approval';
  maxConfidentiality: string;
}

const GRANT_LABELS: Record<AgentGrant['mode'], string> = {
  none: 'No Brain',
  full_delegated: 'Full access',
  agent_decides: 'Agent decides',
  human_approval: 'Ask me first',
};

const STAGE_LABELS: Record<string, string> = {
  sync: 'Sync', normalize: 'Normalize', secure: 'Protect', extract: 'Extract',
  reason: 'Reason', review: 'Review', publish: 'Publish',
};

const SHAPES = [
  { id: 'personal_project', label: 'Personal project' },
  { id: 'professional_practice', label: 'Professional practice' },
  { id: 'product', label: 'Product' },
  { id: 'owner_run_company', label: 'Company I run' },
] as const;

// ── Component ────────────────────────────────────────────────

export function SourcesTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<OwnerProfile | null>(null);
  const [plan, setPlan] = useState<LearningPlan | null>(null);

  const launched = profile?.onboardingState === 'launched';

  const reload = useCallback(async () => {
    try {
      const res = await api<{ profile: OwnerProfile | null; learningPlan: LearningPlan | null }>('/v1/cora/onboarding');
      setProfile(res.profile);
      setPlan(res.learningPlan);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        <Loader2 size={18} className="animate-spin" />
        <span className="ml-2 text-[13px]">Reading your workspace…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="rounded-card border border-line bg-surface-2 p-5 text-[13px] text-text-muted">
          <AlertTriangle size={16} className="mb-2 text-amber-400" />
          <p>{error}</p>
          <button type="button" onClick={() => { setLoading(true); void reload(); }} className="mt-3 rounded-btn bg-accent-soft px-3 py-1.5 text-accent">Retry</button>
        </div>
      </div>
    );
  }
  return launched
    ? <ControlRoom plan={plan} onChanged={reload} />
    : <Quickstart profile={profile} onLaunched={reload} />;
}

// ── Quickstart (RFC §14.7) ───────────────────────────────────

/**
 * Detection-first quickstart (RFC §14.6 "detect before asking"): discovery
 * runs on mount, so the owner reviews a REAL picture of their operation —
 * detected sources with per-source accept toggles, inferred charter, and
 * grant recommendations — on one screen. Intent and shape refine it; nothing
 * is a blank form.
 */
function Quickstart({ profile, onLaunched }: { profile: OwnerProfile | null; onLaunched: () => Promise<void> | void }) {
  const [intent, setIntent] = useState(profile?.intent ?? '');
  const [shape, setShape] = useState<string>(profile?.operatingShape ?? 'personal_project');
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [discovering, setDiscovering] = useState(true);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<DiscoveryResult>('/v1/cora/onboarding/discover', { method: 'POST' })
      .then((result) => {
        setDiscovery(result);
        setAccepted(new Set(result.detectedSources.filter((s) => s.state === 'ready').map((s) => s.sourceType)));
      })
      .catch((err) => setError(apiErrorMessage(err)))
      .finally(() => setDiscovering(false));
  }, []);

  const toggleSource = (sourceType: string, state: SourceCandidate['state']) => {
    if (state !== 'ready') return; // connect/suggested sources join from the catalog after launch
    setAccepted((current) => {
      const next = new Set(current);
      if (next.has(sourceType)) next.delete(sourceType);
      else next.add(sourceType);
      return next;
    });
  };

  const launch = useCallback(async () => {
    if (!discovery) return;
    setLaunching(true);
    setError(null);
    try {
      await api('/v1/cora/onboarding/launch', {
        method: 'POST',
        body: JSON.stringify({
          intent: intent || undefined,
          operatingShape: shape,
          charter: discovery.inferredCharter,
          acceptSources: [...accepted],
          acceptGrants: discovery.suggestedAgentGrants.map((g) => ({ agentId: g.agentId, mode: g.mode })),
        }),
      });
      await onLaunched();
    } catch (err) {
      setError(apiErrorMessage(err));
      setLaunching(false);
    }
  }, [discovery, intent, shape, accepted, onLaunched]);

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto px-6 py-8">
      <div className="grid w-full max-w-4xl gap-6 lg:grid-cols-[1fr_320px]">
        <section>
          <h2 className="text-display text-text-primary">Teach the Brain your operation</h2>
          <p className="mt-1 text-[13px] text-text-muted">
            It learns from your own Agentis activity first, then from the sources you authorize. Private by default; knowledge access never grants action authority.
          </p>

          {discovering && (
            <p className="mt-6 inline-flex items-center gap-2 text-[13px] text-text-muted">
              <Loader2 size={14} className="animate-spin" /> Reading your workspace — agents, workflows, credentials, channels…
            </p>
          )}

          {discovery && (
            <>
              {discovery.inferredCharter && (
                <div className="mt-5 rounded-card border border-line bg-surface-2 p-3.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">What we detected</p>
                  <p className="mt-1 text-[13px] text-text-primary">{discovery.inferredCharter}</p>
                  {discovery.suggestedDomains.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {discovery.suggestedDomains.map((domain) => (
                        <span key={domain} className="rounded-pill bg-surface px-2 py-0.5 text-[10px] text-text-muted">{domain}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <h3 className="mt-6 text-[12px] font-semibold text-text-muted">Sources — select what the Brain may learn from</h3>
              <div className="mt-2 grid gap-2">
                {discovery.detectedSources.map((source) => {
                  const isReady = source.state === 'ready';
                  const isOn = accepted.has(source.sourceType);
                  return (
                    <button
                      key={source.sourceType}
                      type="button"
                      onClick={() => toggleSource(source.sourceType, source.state)}
                      className={`flex items-start gap-3 rounded-card border p-3.5 text-left transition-colors ${
                        isReady && isOn ? 'border-accent/50 bg-accent-soft/30'
                        : 'border-line bg-surface-2'
                      } ${isReady ? 'cursor-pointer hover:border-accent/40' : 'cursor-default opacity-80'}`}
                    >
                      <SourceGlyph sourceType={source.sourceType} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-text-primary">{source.displayName}</span>
                          <StateChip state={source.state} />
                          {!isReady && <span className="text-[10px] text-text-muted">connect after launch from the catalog</span>}
                        </div>
                        <p className="mt-0.5 text-[12px] text-text-muted">{source.reason}</p>
                      </div>
                      {isReady && (
                        <span className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${isOn ? 'border-accent bg-accent text-white' : 'border-line'}`}>
                          {isOn && <Check size={11} />}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 flex items-center gap-2 text-[12px] text-text-muted">
                <ShieldCheck size={14} className="text-emerald-500" />
                Everything stays in this workspace. You can pause, exclude, or delete any source later — removal propagates through learned knowledge.
              </div>
              <button
                type="button"
                onClick={() => void launch()}
                disabled={launching || accepted.size === 0}
                className="mt-5 inline-flex items-center gap-2 rounded-btn bg-accent px-4 py-2.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
              >
                {launching ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                Start learning from {accepted.size} source{accepted.size === 1 ? '' : 's'}
              </button>
            </>
          )}
          {error && <p className="mt-4 text-[12px] text-rose-400">{error}</p>}
        </section>

        <aside className="lg:pt-12">
          <div className="rounded-card border border-line bg-surface-2 p-4">
            <h3 className="text-[12px] font-semibold text-text-primary">Refine (optional)</h3>
            <label className="mt-3 block text-[11px] font-semibold text-text-muted">Intent</label>
            <input
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder='"Run my agency", "Build this product"…'
              className="mt-1 w-full rounded-btn border border-line bg-surface px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent"
            />
            <label className="mt-3 block text-[11px] font-semibold text-text-muted">Operating shape</label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {SHAPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setShape(s.id)}
                  className={`rounded-pill border px-2.5 py-1 text-[11px] transition-colors ${shape === s.id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-text-muted hover:text-text-primary'}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {discovery && discovery.suggestedAgentGrants.length > 0 && (
            <div className="mt-3 rounded-card border border-line bg-surface-2 p-4">
              <h3 className="text-[12px] font-semibold text-text-primary">Agents receiving Brain context</h3>
              <div className="mt-2 grid gap-1.5">
                {discovery.suggestedAgentGrants.map((grant) => (
                  <div key={grant.agentId} className="flex items-center justify-between gap-2">
                    <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-text-primary"><Bot size={12} className="shrink-0 text-text-muted" /><span className="truncate">{grant.agentName}</span></span>
                    <span className="shrink-0 rounded-pill bg-accent-soft px-2 py-0.5 text-[10px] text-accent">{GRANT_LABELS[grant.mode as AgentGrant['mode']] ?? grant.mode}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-text-muted">Adjustable per agent any time after launch.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ── Control room ─────────────────────────────────────────────

function ControlRoom({ plan, onChanged }: { plan: LearningPlan | null; onChanged: () => Promise<void> | void }) {
  const [connections, setConnections] = useState<SourceConnection[]>([]);
  const [available, setAvailable] = useState<RegisteredSource[]>([]);
  const [connectingType, setConnectingType] = useState<string | null>(null);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [identityQueue, setIdentityQueue] = useState<IdentityLinkRow[]>([]);
  const [migrations, setMigrations] = useState<MigrationRow[]>([]);
  const [accessRequests, setAccessRequests] = useState<AccessRequestRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [grants, setGrants] = useState<Record<string, AgentGrant>>({});
  const [syncing, setSyncing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reloadAll = useCallback(async () => {
    const [src, cls, cfs, idq, mig, ags, acc] = await Promise.allSettled([
      api<{ connections: SourceConnection[]; available: RegisteredSource[] }>('/v1/cora/sources'),
      api<{ claims: ClaimRow[] }>('/v1/cora/claims'),
      api<{ conflicts: ConflictRow[] }>('/v1/cora/conflicts'),
      api<{ reviewQueue: IdentityLinkRow[] }>('/v1/cora/identity-links'),
      api<{ candidates: MigrationRow[] }>('/v1/cora/migration-candidates'),
      api<{ agents: AgentRow[] }>('/v1/agents'),
      api<{ requests: AccessRequestRow[] }>('/v1/cora/access-requests'),
    ]);
    if (acc.status === 'fulfilled') setAccessRequests(acc.value.requests);
    if (src.status === 'fulfilled') {
      setConnections(src.value.connections);
      setAvailable(src.value.available ?? []);
    }
    if (cls.status === 'fulfilled') setClaims(cls.value.claims);
    if (cfs.status === 'fulfilled') setConflicts(cfs.value.conflicts);
    if (idq.status === 'fulfilled') setIdentityQueue(idq.value.reviewQueue);
    if (mig.status === 'fulfilled') setMigrations(mig.value.candidates);
    if (ags.status === 'fulfilled') {
      setAgents(ags.value.agents);
      const grantPairs = await Promise.allSettled(
        ags.value.agents.map(async (agent) => [agent.id, await api<AgentGrant>(`/v1/cora/agents/${agent.id}/grant`)] as const),
      );
      const next: Record<string, AgentGrant> = {};
      for (const pair of grantPairs) if (pair.status === 'fulfilled') next[pair.value[0]] = pair.value[1];
      setGrants(next);
    }
  }, []);

  useEffect(() => { void reloadAll(); }, [reloadAll]);

  const syncNow = useCallback(async (connectionId: string) => {
    setSyncing(connectionId);
    setNotice(null);
    try {
      const outcome = await api<{ versionsCreated: number; objectsSeen: number }>(`/v1/cora/sources/${connectionId}/sync`, { method: 'POST' });
      setNotice(`Sync finished — ${outcome.versionsCreated} new evidence version(s) from ${outcome.objectsSeen} object(s).`);
      await reloadAll();
      await onChanged();
    } catch (err) {
      setNotice(apiErrorMessage(err));
    } finally {
      setSyncing(null);
    }
  }, [reloadAll, onChanged]);

  const setGrantMode = useCallback(async (agentId: string, mode: AgentGrant['mode']) => {
    await api(`/v1/cora/agents/${agentId}/grant`, { method: 'PUT', body: JSON.stringify({ mode }) });
    setGrants((prev) => ({ ...prev, [agentId]: { ...(prev[agentId] ?? { agentId, maxConfidentiality: 'internal' }), mode } }));
  }, []);

  const counts = useMemo(() => ({
    active: claims.filter((c) => c.status === 'active').length,
    candidate: claims.filter((c) => c.status === 'candidate').length,
    disputed: claims.filter((c) => c.status === 'disputed').length,
  }), [claims]);

  const stages = (plan?.stagesJson ?? []) as LearningPlanStage[];

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-5xl">

        {/* Learning plan strip */}
        <section className="rounded-card border border-line bg-surface-2 p-4">
          <div className="flex items-center justify-between">
            <h3 className="inline-flex items-center gap-2 text-[13px] font-semibold text-text-primary">
              <Activity size={14} className="text-accent" /> Continuous learning
            </h3>
            <span className="text-[11px] text-text-muted">mode: {plan?.reasoningMode ?? 'adaptive'}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1">
            {stages.map((stage, i) => (
              <div key={stage.kind} className="flex items-center gap-1">
                <span className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[11px] ${
                  stage.status === 'healthy' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                  : stage.status === 'running' ? 'border-accent/30 bg-accent-soft text-accent'
                  : stage.status === 'attention' ? 'border-amber-500/30 bg-amber-500/10 text-amber-500'
                  : 'border-line bg-surface text-text-muted'
                }`}>
                  {stage.status === 'healthy' ? <CheckCircle2 size={11} /> : stage.status === 'attention' ? <AlertTriangle size={11} /> : stage.status === 'paused' ? <Pause size={11} /> : <CircleDashed size={11} />}
                  {STAGE_LABELS[stage.kind] ?? stage.kind}
                </span>
                {i < stages.length - 1 && <ChevronRight size={11} className="text-text-muted/50" />}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-[12px] text-text-muted">
            <span><strong className="text-text-primary">{counts.active}</strong> active claims</span>
            <span><strong className="text-text-primary">{counts.candidate}</strong> forming</span>
            <span className={counts.disputed > 0 ? 'text-amber-500' : ''}><strong>{counts.disputed}</strong> disputed</span>
          </div>
        </section>

        {notice && <p className="mt-3 rounded-card border border-line bg-surface-2 px-3 py-2 text-[12px] text-text-muted">{notice}</p>}

        {/* Sources */}
        <section className="mt-5">
          <h3 className="inline-flex items-center gap-2 text-[13px] font-semibold text-text-primary">
            <Plug size={14} className="text-accent" /> Sources
          </h3>
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
            {connections.map((connection) => (
              <div key={connection.id} className="rounded-card border border-line bg-surface-2 p-3.5">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-text-primary">
                    <SourceGlyph sourceType={connection.sourceType} />
                    {connection.displayName}
                  </span>
                  <StateChip state={connection.status as SourceCandidate['state']} />
                </div>
                <p className="mt-1.5 text-[11px] text-text-muted">
                  {connection.lastSyncAt ? `Last sync ${new Date(connection.lastSyncAt).toLocaleString()}` : 'Never synced'}
                  {connection.healthJson?.ok === false ? ` — ${connection.healthJson.lastOutcome}` : ''}
                </p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => void syncNow(connection.id)}
                    disabled={syncing === connection.id}
                    className="inline-flex items-center gap-1.5 rounded-btn border border-line px-2.5 py-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-60"
                  >
                    {syncing === connection.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    Sync now
                  </button>
                  {available.find((s) => s.sourceType === connection.sourceType)?.capabilities.supportsWebhooks !== false && connection.sourceType !== 'agentis_native' && (
                    <button
                      type="button"
                      onClick={() => {
                        void api<{ path: string }>(`/v1/cora/sources/${connection.id}/webhook/arm`, { method: 'POST' })
                          .then((res) => {
                            void navigator.clipboard?.writeText(`${window.location.origin}${res.path}`).catch(() => {});
                            setNotice(`Webhook armed — ingress URL copied to clipboard: ${res.path}`);
                          })
                          .catch((err) => setNotice(apiErrorMessage(err)));
                      }}
                      className="inline-flex items-center gap-1.5 rounded-btn border border-line px-2.5 py-1 text-[11px] text-text-muted hover:text-text-primary"
                      title="Generate the real-time ingress URL to register with this source"
                    >
                      <Webhook size={11} /> Arm webhook
                    </button>
                  )}
                </div>
              </div>
            ))}
            {connections.length === 0 && (
              <p className="text-[12px] text-text-muted">No sources connected yet.</p>
            )}
          </div>

          {/* Catalog — every registered KnowledgeSource not yet connected */}
          {(() => {
            const connectedTypes = new Set(connections.map((c) => c.sourceType));
            const catalog = available.filter((s) => !connectedTypes.has(s.sourceType));
            if (catalog.length === 0) return null;
            return (
              <div className="mt-3">
                <p className="text-[11px] font-semibold text-text-muted">Available to connect</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {catalog.map((source) => (
                    <button
                      key={source.sourceType}
                      type="button"
                      onClick={() => setConnectingType(source.sourceType)}
                      className="inline-flex items-center gap-2 rounded-card border border-dashed border-line bg-surface-2 px-3 py-2 text-[12px] text-text-muted transition-colors hover:border-accent hover:text-text-primary"
                    >
                      <SourceGlyph sourceType={source.sourceType} />
                      {source.displayName}
                      <Plus size={12} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </section>

        {connectingType && (
          <ConnectSourceDrawer
            source={available.find((s) => s.sourceType === connectingType)!}
            onClose={() => setConnectingType(null)}
            onConnected={async () => {
              setConnectingType(null);
              await reloadAll();
              await onChanged();
            }}
          />
        )}

        {/* Agent access */}
        <section className="mt-6">
          <h3 className="inline-flex items-center gap-2 text-[13px] font-semibold text-text-primary">
            <Lock size={14} className="text-accent" /> Agent access
          </h3>
          <p className="mt-0.5 text-[11px] text-text-muted">Knowledge access only — never credentials, tools, or spending authority.</p>
          <div className="mt-2.5 grid gap-1.5">
            {agents.map((agent) => {
              const grant = grants[agent.id];
              return (
                <div key={agent.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface-2 px-3 py-2">
                  <span className="inline-flex items-center gap-2 text-[13px] text-text-primary">
                    <Bot size={14} className="text-text-muted" />
                    {agent.name}
                    {agent.role && <span className="rounded-pill bg-surface px-2 py-0.5 text-[10px] text-text-muted">{agent.role}</span>}
                  </span>
                  <div className="flex rounded-pill border border-line bg-surface p-0.5 text-[11px]">
                    {(Object.keys(GRANT_LABELS) as Array<AgentGrant['mode']>).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => void setGrantMode(agent.id, mode)}
                        className={`rounded-pill px-2.5 py-1 transition-colors ${grant?.mode === mode ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}
                      >
                        {GRANT_LABELS[mode]}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {agents.length === 0 && <p className="text-[12px] text-text-muted">No agents yet.</p>}
          </div>
        </section>

        {/* Decisions needed */}
        {(conflicts.length > 0 || identityQueue.length > 0 || accessRequests.length > 0) && (
          <section className="mt-6">
            <h3 className="inline-flex items-center gap-2 text-[13px] font-semibold text-amber-500">
              <Scale size={14} /> Needs your decision
            </h3>
            <div className="mt-2.5 grid gap-1.5">
              {conflicts.map((conflict) => (
                <div key={conflict.id} className="flex items-center justify-between rounded-card border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px]">
                  <span className="text-text-primary">
                    {conflict.claimIdsJson.length} claims disagree
                    {conflict.consequentiality === 'protected' && <span className="ml-2 rounded-pill bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-500">protected</span>}
                  </span>
                  <span className="text-text-muted">resolve in Insights → Disputes</span>
                </div>
              ))}
              {accessRequests.map((request) => {
                const agentName = agents.find((a) => a.id === request.agentId)?.name ?? request.agentId;
                return (
                  <div key={request.id} className="rounded-card border border-line bg-surface-2 px-3 py-2 text-[12px]">
                    <p className="text-text-primary"><strong>{agentName}</strong> asks to use Brain knowledge</p>
                    <p className="mt-0.5 text-[11px] text-text-muted">For: {request.purpose}</p>
                    <AccessRequestActions requestId={request.id} onDone={reloadAll} />
                  </div>
                );
              })}
              {identityQueue.map((link) => (
                <div key={link.id} className="flex items-center justify-between rounded-card border border-line bg-surface-2 px-3 py-2 text-[12px]">
                  <span className="inline-flex items-center gap-2 text-text-primary"><GitMerge size={13} className="text-text-muted" /> Possible identity match ({Math.round(link.confidence * 100)}%)</span>
                  <IdentityActions linkId={link.id} onDone={reloadAll} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Deep investigation */}
        <InvestigationPanel />

        {/* Migration opportunities */}
        <section className="mt-6 pb-8">
          <h3 className="inline-flex items-center gap-2 text-[13px] font-semibold text-text-primary">
            <Workflow size={14} className="text-accent" /> Agentis-native opportunities
          </h3>
          <p className="mt-0.5 text-[11px] text-text-muted">Repeated external work the Brain has observed. Nothing activates without your approval.</p>
          <div className="mt-2.5 grid gap-1.5">
            {migrations.map((candidate) => (
              <div key={candidate.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface-2 px-3 py-2.5">
                <div className="min-w-0">
                  <span className="text-[13px] text-text-primary">{candidate.title}</span>
                  <p className="text-[11px] text-text-muted">
                    seen ×{candidate.recurrence} — suggests <strong>{candidate.recommendedTarget.replace('_', ' ')}</strong>
                  </p>
                </div>
                <span className="flex items-center gap-2">
                  <span className={`rounded-pill px-2.5 py-0.5 text-[11px] ${
                    candidate.status === 'candidate' ? 'bg-accent-soft text-accent'
                    : candidate.status === 'observing' ? 'bg-surface text-text-muted'
                    : 'bg-emerald-500/10 text-emerald-500'
                  }`}>
                    {candidate.status === 'observing' ? <span className="inline-flex items-center gap-1"><Eye size={11} /> observing</span> : candidate.status.replace(/_/g, ' ')}
                  </span>
                  <MigrationActions candidate={candidate} onDone={reloadAll} />
                </span>
              </div>
            ))}
            {migrations.length === 0 && (
              <p className="text-[12px] text-text-muted">None yet — the Brain proposes opportunities once it has trustworthy, corroborated process evidence.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────

/**
 * Connect-a-source drawer (§7.2/§7.3): credential → live scope discovery →
 * inclusion selection (default-deny) → learning brief purpose → connect +
 * sample sync. Every step explains itself; nothing requires docs.
 */
function ConnectSourceDrawer({ source, onClose, onConnected }: {
  source: RegisteredSource;
  onClose: () => void;
  onConnected: () => Promise<void> | void;
}) {
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [credentialId, setCredentialId] = useState<string>('');
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [showManual, setShowManual] = useState(false);
  const [scopes, setScopes] = useState<DiscoveredScope[] | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [purpose, setPurpose] = useState<string>('operations');
  const [objectives, setObjectives] = useState('');
  const [health, setHealth] = useState<{ ok: boolean; detail?: string } | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsCredential = source.sourceType !== 'agentis_native';
  const oauth = SOURCE_OAUTH[source.sourceType];
  const oauthProvider = oauth ? providers.find((p) => p.id === oauth.providerId) : undefined;
  const oauthAvailable = Boolean(oauth && oauthProvider?.configured);

  useEffect(() => {
    void api<{ credentials: CredentialRow[] }>('/v1/credentials')
      .then((res) => setCredentials(res.credentials))
      .catch(() => setCredentials([]));
    void api<{ providers: OAuthProvider[] }>('/v1/oauth/providers')
      .then((res) => setProviders(res.providers ?? []))
      .catch(() => setProviders([]));
  }, []);

  const createAndDiscover = useCallback(async (credIdOverride?: string) => {
    const credId = credIdOverride ?? credentialId;
    setBusy('discover');
    setError(null);
    try {
      let id = connectionId;
      if (!id) {
        const created = await api<{ id: string }>('/v1/cora/sources', {
          method: 'POST',
          body: JSON.stringify({
            sourceType: source.sourceType,
            credentialId: credId || null,
            learningBrief: { purpose, knowledgeObjectives: objectives ? objectives.split('\n').filter(Boolean) : [] },
          }),
        });
        id = created.id;
        setConnectionId(id);
      } else if (credId) {
        await api(`/v1/cora/sources/${id}`, { method: 'PATCH', body: JSON.stringify({ credentialId: credId }) }).catch(() => {});
      }
      const result = await api<{ health: { ok: boolean; detail?: string }; scopes: DiscoveredScope[] }>(`/v1/cora/sources/${id}/scopes`);
      setHealth(result.health);
      if (result.health.ok) {
        setScopes(result.scopes);
        setIncluded(new Set(result.scopes.filter((s) => s.recommended).map((s) => s.id)));
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [connectionId, credentialId, objectives, purpose, source.sourceType]);

  /** One-click "Sign in with X" — the existing popup OAuth flow mints a vault credential. */
  const connectWithOAuth = useCallback(() => {
    if (!oauth) return;
    setBusy('oauth');
    setError(null);
    void api<{ url: string }>(`/v1/oauth/${oauth.providerId}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ integrationSlug: oauth.slug, origin: window.location.origin }),
    }).then(({ url }) => {
      const popup = window.open(url, 'agentis-oauth', 'popup,width=520,height=680');
      const onMessage = (event: MessageEvent) => {
        const message = event.data as { type?: string; ok?: boolean; credentialId?: string; error?: string };
        if (message?.type !== 'agentis-oauth') return;
        window.removeEventListener('message', onMessage);
        if (message.ok && message.credentialId) {
          setCredentialId(message.credentialId);
          void createAndDiscover(message.credentialId);
        } else {
          setError(message.error ?? 'Sign-in was cancelled.');
          setBusy(null);
        }
      };
      window.addEventListener('message', onMessage);
      const poll = setInterval(() => {
        if (popup?.closed) {
          clearInterval(poll);
          window.removeEventListener('message', onMessage);
          setBusy((current) => (current === 'oauth' ? null : current));
        }
      }, 800);
    }).catch((err) => {
      setError(apiErrorMessage(err));
      setBusy(null);
    });
  }, [oauth, createAndDiscover]);

  const finishConnect = async () => {
    if (!connectionId) return;
    setBusy('connect');
    setError(null);
    try {
      await api(`/v1/cora/sources/${connectionId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'ready',
          includedScopes: [...included],
          learningBrief: { purpose, knowledgeObjectives: objectives ? objectives.split('\n').filter(Boolean) : [] },
        }),
      });
      // First bounded sample proves the pipe before broad backfill (§14.7 M3).
      await api(`/v1/cora/onboarding/sample`, { method: 'POST', body: JSON.stringify({ connectionId }) }).catch(() => {});
      await onConnected();
    } catch (err) {
      setError(apiErrorMessage(err));
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="flex h-full w-[420px] flex-col border-l border-line bg-surface" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <SourceGlyph sourceType={source.sourceType} />
            <div>
              <h3 className="text-[14px] font-semibold text-text-primary">Connect {source.displayName}</h3>
              <p className="text-[11px] text-text-muted">Default-deny: only what you include here syncs.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-btn p-1.5 text-text-muted hover:bg-surface-3 hover:text-text-primary"><X size={15} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {needsCredential && (
            <>
              <label className="block text-[11px] font-semibold text-text-muted">Authorize</label>

              {/* Rung 1/2: one-click "Sign in with X" (popup OAuth → vault credential). */}
              {oauthAvailable && (
                <button
                  type="button"
                  onClick={connectWithOAuth}
                  disabled={busy !== null}
                  className="mt-1.5 inline-flex w-full items-center justify-center gap-2 rounded-btn bg-accent px-3.5 py-2.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
                >
                  {busy === 'oauth' ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                  Sign in with {oauth!.label}
                </button>
              )}

              {/* OAuth-mapped source whose provider isn't enabled on this server. */}
              {oauth && !oauthAvailable && (
                <p className="mt-1.5 rounded-card border border-line bg-surface-2 px-3 py-2 text-[11px] text-text-muted">
                  One-click {oauth.label} sign-in isn’t enabled on this server. Enable <code className="text-text-secondary">AGENTIS_OAUTH_PROXY_URL</code> or set the {oauth.label} client credentials (see docs/OAUTH-STRATEGY.md), or use a stored token below.
                </p>
              )}

              {/* Rung 3 fallback: bring-your-own stored token. */}
              {oauthAvailable ? (
                <button
                  type="button"
                  onClick={() => setShowManual((v) => !v)}
                  className="mt-2 text-[11px] text-text-muted underline decoration-dotted underline-offset-2 hover:text-text-primary"
                >
                  {showManual ? 'Hide stored-token option' : 'Use a stored token instead'}
                </button>
              ) : null}

              {(showManual || !oauthAvailable) && (
                <div className="mt-2">
                  <select
                    value={credentialId}
                    onChange={(e) => setCredentialId(e.target.value)}
                    className="w-full rounded-btn border border-line bg-surface-2 px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent"
                  >
                    <option value="">Select a stored credential…</option>
                    {credentials.map((cred) => (
                      <option key={cred.id} value={cred.id}>{cred.name} ({cred.credentialType})</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[10px] text-text-muted">Add tokens under Settings → Credentials.</p>
                </div>
              )}
            </>
          )}

          <label className="mt-4 block text-[11px] font-semibold text-text-muted">What should the Brain learn from this source?</label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {BRIEF_PURPOSES.map((p) => (
              <button key={p} type="button" onClick={() => setPurpose(p)}
                className={`rounded-pill border px-2.5 py-1 text-[11px] capitalize transition-colors ${purpose === p ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface-2 text-text-muted hover:text-text-primary'}`}>
                {p}
              </button>
            ))}
          </div>
          <textarea
            value={objectives}
            onChange={(e) => setObjectives(e.target.value)}
            placeholder={'Optional objectives, one per line:\nDecisions and commitments\nWho owns what'}
            rows={3}
            className="mt-2 w-full resize-none rounded-btn border border-line bg-surface-2 px-3 py-2 text-[12px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
          />

          {!scopes && (!needsCredential || credentialId) && (
            <button
              type="button"
              onClick={() => void createAndDiscover()}
              disabled={busy !== null}
              className="mt-4 inline-flex items-center gap-2 rounded-btn bg-accent px-3.5 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
            >
              {busy === 'discover' ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
              Validate &amp; discover scopes
            </button>
          )}
          {health && !health.ok && (
            <p className="mt-3 rounded-card border border-rose-400/30 bg-rose-500/5 px-3 py-2 text-[12px] text-rose-400">
              {health.detail ?? 'Connection failed — check the credential.'}
            </p>
          )}

          {scopes && (
            <>
              <label className="mt-5 block text-[11px] font-semibold text-text-muted">
                Include ({included.size}/{scopes.length}) — everything else stays out
              </label>
              <div className="mt-1.5 grid max-h-56 gap-1 overflow-y-auto rounded-card border border-line bg-surface-2 p-2">
                {scopes.map((scope) => {
                  const on = included.has(scope.id);
                  return (
                    <button
                      key={scope.id}
                      type="button"
                      onClick={() => setIncluded((cur) => { const next = new Set(cur); if (on) next.delete(scope.id); else next.add(scope.id); return next; })}
                      className={`flex items-center justify-between rounded px-2.5 py-1.5 text-left text-[12px] transition-colors ${on ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-surface-3 hover:text-text-primary'}`}
                    >
                      <span className="truncate">{scope.label}</span>
                      <span className="ml-2 shrink-0 text-[10px] opacity-70">{scope.kind.replace(/_/g, ' ')}</span>
                    </button>
                  );
                })}
                {scopes.length === 0 && <p className="px-2 py-1 text-[11px] text-text-muted">No scopes exposed — the whole authorized surface syncs.</p>}
              </div>
              {source.capabilities.supportsWebhooks && (
                <p className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-text-muted"><Webhook size={11} /> Real-time webhooks can be armed after connecting (source card → Arm webhook).</p>
              )}
            </>
          )}
        </div>

        <footer className="border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={() => void finishConnect()}
            disabled={!scopes || busy !== null}
            className="inline-flex w-full items-center justify-center gap-2 rounded-btn bg-accent px-3 py-2.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
          >
            {busy === 'connect' ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
            Connect &amp; run first sample
          </button>
        </footer>
      </aside>
    </div>
  );
}

/** §18.2 lifecycle: each step is an explicit owner action; nothing self-activates. */
function MigrationActions({ candidate, onDone }: { candidate: MigrationRow; onDone: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = candidate.status === 'candidate' ? { action: 'investigate', label: 'Investigate' }
    : candidate.status === 'investigating' ? { action: 'draft', label: 'Generate draft' }
    : candidate.status === 'draft_ready' ? { action: 'shadow', label: 'Shadow' }
    : candidate.status === 'shadowing' ? { action: 'approve', label: 'Approve as workflow' }
    : null;
  if (!step) return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/cora/migration-candidates/${candidate.id}/${step.action}`, { method: 'POST' });
      await onDone();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <button type="button" disabled={busy} onClick={() => void run()} className="rounded-btn bg-accent-soft px-2 py-0.5 text-[11px] text-accent disabled:opacity-50" title={error ?? undefined}>
        {busy ? <Loader2 size={11} className="animate-spin" /> : step.label}
      </button>
      {error && <span className="max-w-[180px] truncate text-[10px] text-rose-400" title={error}>{error}</span>}
    </span>
  );
}

function AccessRequestActions({ requestId, onDone }: { requestId: string; onDone: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approve' | 'reject', scope?: string) => {
    setBusy(true);
    try {
      await api(`/v1/cora/access-requests/${requestId}/${decision}`, {
        method: 'POST',
        body: JSON.stringify(scope ? { scope } : {}),
      });
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      <button type="button" disabled={busy} onClick={() => void decide('approve', 'once')} className="rounded-btn bg-accent-soft px-2 py-0.5 text-[11px] text-accent disabled:opacity-50">Allow once</button>
      <button type="button" disabled={busy} onClick={() => void decide('approve', 'session')} className="rounded-btn bg-accent-soft px-2 py-0.5 text-[11px] text-accent disabled:opacity-50">Allow 8h</button>
      <button type="button" disabled={busy} onClick={() => void decide('approve', 'standing')} className="rounded-btn bg-accent-soft px-2 py-0.5 text-[11px] text-accent disabled:opacity-50">Always allow</button>
      <button type="button" disabled={busy} onClick={() => void decide('reject')} className="rounded-btn border border-line px-2 py-0.5 text-[11px] text-text-muted disabled:opacity-50">Deny</button>
    </div>
  );
}

/** Owner-launched Deep investigation (§11.2) — visible cost class, honest no-op when ungrounded. */
function InvestigationPanel() {
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<InvestigationRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!question.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const launched = await api<{ id: string }>('/v1/cora/investigations', {
        method: 'POST',
        body: JSON.stringify({ question: question.trim() }),
      });
      const detail = await api<InvestigationRow>(`/v1/cora/investigations/${launched.id}`);
      setResult(detail);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="mt-6">
      <h3 className="inline-flex items-center gap-2 text-[13px] font-semibold text-text-primary">
        <Sparkles size={14} className="text-accent" /> Investigate
      </h3>
      <p className="mt-0.5 text-[11px] text-text-muted">Ask a deep question about your operation. Answers are cited or honestly inconclusive — never invented.</p>
      <div className="mt-2 flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
          placeholder='e.g. "Who owns the invoice process and is it still current?"'
          className="flex-1 rounded-btn border border-line bg-surface-2 px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent"
        />
        <button type="button" disabled={running || !question.trim()} onClick={() => void run()} className="inline-flex items-center gap-1.5 rounded-btn bg-accent px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-50">
          {running ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
          Run
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-rose-400">{error}</p>}
      {result && (
        <div className="mt-2.5 rounded-card border border-line bg-surface-2 p-3 text-[12px]">
          <div className="flex items-center gap-2">
            <span className={`rounded-pill px-2 py-0.5 text-[10px] font-semibold ${
              result.status === 'completed' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
            }`}>{result.status}</span>
            <span className="text-[11px] text-text-muted">grounding {Math.round(result.grounding * 100)}%</span>
          </div>
          {result.explanation && <p className="mt-2 whitespace-pre-wrap text-text-primary">{result.explanation}</p>}
          {(result.gapsJson ?? []).length > 0 && (
            <ul className="mt-2 list-disc pl-4 text-[11px] text-text-muted">
              {result.gapsJson.map((gap, i) => <li key={i}>{gap}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function IdentityActions({ linkId, onDone }: { linkId: string; onDone: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await api(`/v1/cora/identity-links/${linkId}/resolve`, { method: 'POST', body: JSON.stringify({ decision }) });
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex gap-1.5">
      <button type="button" disabled={busy} onClick={() => void decide('approve')} className="rounded-btn bg-accent-soft px-2 py-0.5 text-[11px] text-accent disabled:opacity-50">Same person</button>
      <button type="button" disabled={busy} onClick={() => void decide('reject')} className="rounded-btn border border-line px-2 py-0.5 text-[11px] text-text-muted disabled:opacity-50">Different</button>
    </span>
  );
}

function StateChip({ state }: { state: SourceCandidate['state'] | string }) {
  const map: Record<string, { label: string; cls: string }> = {
    ready: { label: 'Ready', cls: 'bg-emerald-500/10 text-emerald-500' },
    connect: { label: 'Connect', cls: 'bg-accent-soft text-accent' },
    suggested_later: { label: 'Later', cls: 'bg-surface text-text-muted' },
    needs_attention: { label: 'Attention', cls: 'bg-amber-500/10 text-amber-500' },
    paused: { label: 'Paused', cls: 'bg-surface text-text-muted' },
    revoked: { label: 'Revoked', cls: 'bg-rose-500/10 text-rose-400' },
  };
  const entry = map[state] ?? { label: state, cls: 'bg-surface text-text-muted' };
  return <span className={`rounded-pill px-2 py-0.5 text-[10px] font-semibold ${entry.cls}`}>{entry.label}</span>;
}

/** Logo placeholder keyed by source slug — official logos resolve through the connector logo system when available. */
function SourceGlyph({ sourceType }: { sourceType: string }) {
  const letter = sourceType === 'agentis_native' ? 'A' : sourceType.charAt(0).toUpperCase();
  const accent = sourceType === 'agentis_native';
  return (
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-[12px] font-bold ${accent ? 'bg-accent-soft text-accent' : 'bg-surface text-text-muted'}`}>
      {sourceType === 'agentis_native' ? <Sparkles size={13} /> : letter}
    </span>
  );
}
