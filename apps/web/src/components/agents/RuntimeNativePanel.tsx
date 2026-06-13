import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Box,
  Check,
  CircleAlert,
  Clock3,
  FileCode2,
  FileText,
  FolderTree,
  KeyRound,
  MemoryStick,
  PlugZap,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  Workflow,
} from 'lucide-react';
import type {
  RuntimeDescriptor,
  RuntimeResourceContent,
  RuntimeResourceDescriptor,
  RuntimeSessionInfo,
} from '@agentis/core';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';

type PanelMode = 'overview' | 'resources';

interface EffectiveContextLayer {
  precedence: number;
  resource: RuntimeResourceDescriptor;
}

export function RuntimeNativePanel({
  agentId,
  mode = 'overview',
}: {
  agentId: string;
  mode?: PanelMode;
}) {
  const toast = useToast();
  const [runtime, setRuntime] = useState<RuntimeDescriptor | null>(null);
  const [resources, setResources] = useState<RuntimeResourceDescriptor[]>([]);
  const [sessions, setSessions] = useState<RuntimeSessionInfo[]>([]);
  const [layers, setLayers] = useState<EffectiveContextLayer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<RuntimeResourceContent | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [filter, setFilter] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [runtimeResult, resourceResult, sessionResult, contextResult] = await Promise.all([
        api<{ runtime: RuntimeDescriptor }>(`/v1/agents/${agentId}/runtime`),
        api<{ resources: RuntimeResourceDescriptor[] }>(`/v1/agents/${agentId}/runtime/resources`),
        api<{ sessions: RuntimeSessionInfo[] }>(`/v1/agents/${agentId}/runtime/sessions`),
        api<{ layers: EffectiveContextLayer[] }>(`/v1/agents/${agentId}/runtime/effective-context`),
      ]);
      setRuntime(runtimeResult.runtime);
      setResources(resourceResult.resources ?? []);
      setSessions(sessionResult.sessions ?? []);
      setLayers(contextResult.layers ?? []);
      setSelectedId((current) => {
        if (current && resourceResult.resources.some((resource) => resource.id === current)) return current;
        return resourceResult.resources.find((resource) => (
          resource.effective && (resource.kind === 'identity' || resource.kind === 'instructions')
        ))?.id
          ?? resourceResult.resources.find((resource) => (
            resource.effective && resource.kind === 'generated_overlay'
          ))?.id
          ?? resourceResult.resources[0]?.id
          ?? null;
      });
    } catch (error) {
      toast.error('Runtime inspection failed', apiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setDraft('');
      return;
    }
    let cancelled = false;
    setReading(true);
    void api<RuntimeResourceContent>(
      `/v1/agents/${agentId}/runtime/resources/${encodeURIComponent(selectedId)}`,
    ).then((result) => {
      if (cancelled) return;
      setSelected(result);
      setDraft(result.content);
    }).catch((error) => {
      if (!cancelled) toast.error('Could not read runtime resource', apiErrorMessage(error));
    }).finally(() => {
      if (!cancelled) setReading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, selectedId, toast]);

  const filteredResources = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return resources;
    return resources.filter((resource) => [
      resource.name,
      resource.description,
      resource.path,
      resource.kind,
      resource.scope,
    ].some((value) => value?.toLowerCase().includes(query)));
  }, [filter, resources]);

  async function probe() {
    setProbing(true);
    try {
      const result = await api<{ runtime: RuntimeDescriptor }>(
        `/v1/agents/${agentId}/runtime/probe`,
        { method: 'POST' },
      );
      setRuntime(result.runtime);
      toast.success('Runtime probed', 'Effective profile and health were refreshed.');
    } catch (error) {
      toast.error('Runtime probe failed', apiErrorMessage(error));
    } finally {
      setProbing(false);
    }
  }

  async function save() {
    if (!selected || !selected.resource.editable || selected.resource.sensitive) return;
    setSaving(true);
    try {
      const result = await api<RuntimeResourceContent>(
        `/v1/agents/${agentId}/runtime/resources/${encodeURIComponent(selected.resource.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            content: draft,
            expectedChecksum: selected.resource.checksum,
          }),
        },
      );
      setSelected(result);
      setDraft(result.content);
      setResources((current) => current.map((resource) => (
        resource.id === result.resource.id ? result.resource : resource
      )));
      toast.success('Runtime resource saved', reloadMessage(result.resource));
    } catch (error) {
      toast.error('Could not save runtime resource', apiErrorMessage(error));
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function closeSession(sessionKey: string) {
    try {
      await api(
        `/v1/agents/${agentId}/runtime/sessions/${encodeURIComponent(sessionKey)}`,
        { method: 'DELETE' },
      );
      setSessions((current) => current.filter((session) => session.sessionKey !== sessionKey));
      toast.success('Runtime session detached');
    } catch (error) {
      toast.error('Could not detach session', apiErrorMessage(error));
    }
  }

  if (loading) return <Skeleton height={mode === 'resources' ? 560 : 360} />;

  return (
    <div className="space-y-5">
      {runtime && mode === 'overview' && (
        <RuntimeHeader runtime={runtime} probing={probing} onProbe={() => void probe()} />
      )}

      {mode === 'overview' && runtime && (
        <div className="grid gap-3 md:grid-cols-4">
          <RuntimeMetric
            label="Effective model"
            value={runtime.currentModel?.value ?? 'Runtime default'}
            detail={runtime.currentModel
              ? `${runtime.currentModel.source} · ${runtime.currentModel.verified ? 'verified' : 'unverified'}`
              : 'No model reported'}
            icon={<Sparkles size={14} />}
          />
          <RuntimeMetric
            label="Profile"
            value={runtime.profile?.value ?? 'default'}
            detail={runtime.home?.value ?? 'Remote or undiscovered'}
            icon={<FolderTree size={14} />}
          />
          <RuntimeMetric
            label="Process"
            value={runtime.process.warm ? 'Warm' : 'Cold'}
            detail={`${runtime.process.activeSessions ?? sessions.length} attached sessions`}
            icon={<TerminalSquare size={14} />}
          />
          <RuntimeMetric
            label="Resources"
            value={String(runtime.resourceCount)}
            detail="Profile, project, memory, and skills"
            icon={<Box size={14} />}
          />
        </div>
      )}

      <div className="grid min-h-[520px] overflow-hidden rounded-card border border-line bg-surface lg:grid-cols-[300px_1fr]">
        <aside className="border-b border-line bg-surface-2/45 lg:border-b-0 lg:border-r">
          <div className="border-b border-line p-3">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
                  Runtime workspace
                </div>
                <div className="mt-0.5 text-[12px] text-text-secondary">
                  {resources.length} discovered resources
                </div>
              </div>
              <ShieldCheck size={16} className="text-accent" />
            </div>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter files, skills, memory..."
              className="w-full rounded-input border border-line bg-surface px-2.5 py-2 text-[12px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
            />
          </div>
          <div className="max-h-[620px] overflow-y-auto p-2">
            {filteredResources.map((resource) => (
              <ResourceButton
                key={resource.id}
                resource={resource}
                active={resource.id === selectedId}
                onClick={() => setSelectedId(resource.id)}
              />
            ))}
            {filteredResources.length === 0 && (
              <div className="px-3 py-8 text-center text-[12px] text-text-muted">
                No runtime resources match this filter.
              </div>
            )}
          </div>
        </aside>

        <section className="min-w-0">
          {reading ? (
            <div className="p-5"><Skeleton height={430} /></div>
          ) : selected ? (
            <ResourceEditor
              resource={selected.resource}
              content={draft}
              dirty={draft !== selected.content}
              saving={saving}
              onChange={setDraft}
              onSave={() => void save()}
            />
          ) : (
            <div className="flex h-full min-h-[420px] flex-col items-center justify-center px-8 text-center">
              <FolderTree size={34} className="text-text-muted" />
              <h3 className="mt-3 text-subheading text-text-primary">No resource selected</h3>
              <p className="mt-1 max-w-sm text-[13px] text-text-secondary">
                Agentis found no editable runtime context for this profile.
              </p>
            </div>
          )}
        </section>
      </div>

      {mode === 'overview' && (
        <div className="grid gap-4 xl:grid-cols-2">
          <ContextStack layers={layers} />
          <SessionList sessions={sessions} onClose={(sessionKey) => void closeSession(sessionKey)} />
        </div>
      )}
    </div>
  );
}

function RuntimeHeader({
  runtime,
  probing,
  onProbe,
}: {
  runtime: RuntimeDescriptor;
  probing: boolean;
  onProbe: () => void;
}) {
  const healthy = runtime.health.isHealthy;
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface p-5">
      <div className="pointer-events-none absolute inset-y-0 right-0 w-2/5 bg-[radial-gradient(circle_at_80%_20%,rgba(83,214,151,0.12),transparent_62%)]" />
      <div className="relative flex flex-wrap items-start gap-4">
        <div className={`mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl border ${
          healthy ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'
        }`}>
          <PlugZap size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-heading text-text-primary">{runtime.displayName}</h2>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              healthy
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-danger/30 bg-danger/10 text-danger'
            }`}>
              {healthy ? 'connected' : 'needs attention'}
            </span>
            <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted">
              {runtime.process.warm ? 'warm process' : 'cold process'}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-text-secondary">
            {healthy
              ? 'Agentis is using this runtime profile directly and reporting its effective state.'
              : runtime.health.error ?? 'The runtime could not be reached.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-text-muted">
            <span>{runtime.binary?.value ?? runtime.adapterType}</span>
            {runtime.home?.value && <span className="truncate">{runtime.home.value}</span>}
            <span>probed {formatRelative(runtime.probedAt)}</span>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<RefreshCw size={12} className={probing ? 'animate-spin' : ''} />}
          disabled={probing}
          onClick={onProbe}
        >
          Probe
        </Button>
      </div>
    </div>
  );
}

function RuntimeMetric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {icon} {label}
      </div>
      <div className="mt-2 truncate text-[14px] font-semibold text-text-primary" title={value}>{value}</div>
      <div className="mt-1 truncate text-[11px] text-text-muted" title={detail}>{detail}</div>
    </div>
  );
}

function ResourceButton({
  resource,
  active,
  onClick,
}: {
  resource: RuntimeResourceDescriptor;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1 flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
        active
          ? 'border-accent/35 bg-accent-soft text-text-primary'
          : 'border-transparent text-text-secondary hover:border-line hover:bg-surface'
      }`}
    >
      <span className={`mt-0.5 ${active ? 'text-accent' : 'text-text-muted'}`}>
        {resourceIcon(resource)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11px]" title={resource.name}>
          {resource.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
          <span>{resource.kind.replace(/_/g, ' ')}</span>
          <span>·</span>
          <span>{resource.scope}</span>
          {!resource.effective && <span className="text-warning">not created</span>}
        </span>
      </span>
      {resource.sensitive ? (
        <KeyRound size={11} className="mt-0.5 text-warning" />
      ) : resource.editable ? (
        <Check size={11} className="mt-0.5 text-success" />
      ) : null}
    </button>
  );
}

function ResourceEditor({
  resource,
  content,
  dirty,
  saving,
  onChange,
  onSave,
}: {
  resource: RuntimeResourceDescriptor;
  content: string;
  dirty: boolean;
  saving: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
}) {
  const editable = resource.editable && !resource.sensitive
    && resource.format !== 'directory' && resource.format !== 'database';
  return (
    <div className="flex h-full min-h-[520px] flex-col">
      <div className="border-b border-line px-4 py-3.5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] font-semibold text-text-primary">{resource.name}</span>
              <ResourceBadge value={resource.origin} />
              <ResourceBadge value={resource.scope} />
              {resource.sensitive && <ResourceBadge value="redacted" tone="warning" />}
            </div>
            <p className="mt-1 text-[11px] text-text-muted">{resource.description}</p>
            {resource.path && (
              <p className="mt-1.5 truncate font-mono text-[10px] text-text-muted" title={resource.path}>
                {resource.path}
              </p>
            )}
          </div>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Save size={12} />}
            disabled={!editable || !dirty || saving}
            onClick={onSave}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-text-muted">
          <span className="rounded-md bg-surface-2 px-2 py-1">loads {resource.loadPolicy.replace(/_/g, ' ')}</span>
          <span className="rounded-md bg-surface-2 px-2 py-1">{reloadMessage(resource)}</span>
          {resource.sizeBytes !== undefined && (
            <span className="rounded-md bg-surface-2 px-2 py-1">{formatBytes(resource.sizeBytes)}</span>
          )}
          {resource.checksum && (
            <span className="rounded-md bg-surface-2 px-2 py-1 font-mono">sha256 {resource.checksum.slice(0, 10)}</span>
          )}
        </div>
      </div>
      {resource.format === 'directory' || resource.format === 'database' ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <FolderTree size={34} className="text-text-muted" />
          <h3 className="mt-3 text-subheading text-text-primary">Inspectable runtime resource</h3>
          <p className="mt-1 max-w-md text-[13px] text-text-secondary">
            Agentis tracks this resource without opening its internal database or directory as plaintext.
          </p>
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(event) => onChange(event.target.value)}
          readOnly={!editable}
          spellCheck={false}
          className="min-h-[430px] flex-1 resize-none border-0 bg-[#0b0d10] p-5 font-mono text-[12px] leading-6 text-text-primary outline-none read-only:text-text-secondary"
        />
      )}
    </div>
  );
}

function ContextStack({ layers }: { layers: EffectiveContextLayer[] }) {
  return (
    <section className="rounded-card border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Workflow size={14} className="text-accent" />
        <h3 className="text-[12px] font-semibold text-text-primary">Effective context</h3>
        <span className="ml-auto text-[10px] text-text-muted">highest precedence first</span>
      </div>
      <div className="p-3">
        {layers.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-text-muted">No effective context layers detected.</p>
        ) : layers.map((layer) => (
          <div key={layer.resource.id} className="flex items-center gap-3 border-b border-line/70 px-2 py-2.5 last:border-0">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 font-mono text-[10px] text-accent">
              {layer.precedence}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[11px] text-text-primary">{layer.resource.name}</span>
              <span className="text-[10px] text-text-muted">
                {layer.resource.kind.replace(/_/g, ' ')} · {layer.resource.origin}
              </span>
            </span>
            <span className="text-[10px] text-text-muted">{layer.resource.loadPolicy}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SessionList({
  sessions,
  onClose,
}: {
  sessions: RuntimeSessionInfo[];
  onClose: (sessionKey: string) => void;
}) {
  return (
    <section className="rounded-card border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Activity size={14} className="text-accent" />
        <h3 className="text-[12px] font-semibold text-text-primary">Conversation sessions</h3>
        <span className="ml-auto text-[10px] text-text-muted">{sessions.length} attached</span>
      </div>
      <div className="p-3">
        {sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-text-muted">
            A runtime session will appear after the first conversation turn.
          </p>
        ) : sessions.map((session) => (
          <div key={session.id} className="group flex items-center gap-3 border-b border-line/70 px-2 py-2.5 last:border-0">
            <span className={`h-2 w-2 rounded-full ${
              session.status === 'error' || session.status === 'stale' ? 'bg-warning' : 'bg-success'
            }`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[11px] text-text-primary" title={session.sessionKey}>
                {session.sessionKey}
              </span>
              <span className="text-[10px] text-text-muted">
                {session.status} · used {formatRelative(session.lastUsedAt)}
                {session.selectedModel ? ` · ${session.selectedModel}` : ''}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onClose(session.sessionKey)}
              className="rounded-md p-1.5 text-text-muted opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
              aria-label="Detach runtime session"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function ResourceBadge({
  value,
  tone = 'default',
}: {
  value: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <span className={`rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
      tone === 'warning'
        ? 'border-warning/30 bg-warning/10 text-warning'
        : 'border-line bg-surface-2 text-text-muted'
    }`}>
      {value}
    </span>
  );
}

function resourceIcon(resource: RuntimeResourceDescriptor) {
  if (resource.kind === 'memory') return <MemoryStick size={13} />;
  if (resource.kind === 'skill' || resource.kind === 'plugin') return <PlugZap size={13} />;
  if (resource.kind === 'config') return <FileCode2 size={13} />;
  if (resource.kind === 'secret_reference') return <KeyRound size={13} />;
  if (resource.kind === 'session') return <Clock3 size={13} />;
  if (resource.kind === 'generated_overlay') return <Sparkles size={13} />;
  if (resource.sensitive) return <CircleAlert size={13} />;
  return <FileText size={13} />;
}

function reloadMessage(resource: RuntimeResourceDescriptor): string {
  if (resource.reloadPolicy === 'automatic') return 'applies automatically';
  if (resource.reloadPolicy === 'new_session') return 'applies to new sessions';
  return 'runtime restart required';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return 'recently';
  const elapsed = Date.now() - value;
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
