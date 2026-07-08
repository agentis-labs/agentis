/**
 * AppsPage â€” the Agentic App index. One primitive: every item is an App.
 *
 * Clean list, like the workflows page it replaces: search, import, a single
 * "New app" create, and a grid. Opening an App goes to the unified editor
 * (`/apps/:id`). A legacy bare workflow is promoted transactionally to an
 * App-of-one when opened, so every detail page has the same App contract.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  Boxes,
  Download,
  LayoutGrid,
  Loader2,
  Plus,
  Puzzle,
  Search,
  Settings,
  Upload,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import type { AppInstallPreview, AppManifestEnvelope, AppRecord, AppSurface } from '@agentis/core';
import { appsApi, type AppUpdatePayload } from '../lib/appsApi';
import { APP_TEMPLATES } from '../lib/appTemplates';
import { api, apiCached, peekCached, apiErrorMessage } from '../lib/api';
import { AppEngineModal, type AppEngineAgent, type AppEngineDomain } from '../components/apps/AppEngineModal';
import { ExtensionsModal } from '../components/extensions/ExtensionsModal';
import { DomainToolbar, type DomainToolbarSelection } from '../components/shared/DomainToolbar';

interface WorkflowRow {
  id: string;
  title: string;
  status?: string;
  appId?: string | null;
  spaceId?: string | null;
  ownerAgentId?: string | null;
}

interface DomainRow {
  id: string;
  name: string;
  colorHex?: string | null;
  managerId?: string | null;
  parentDomainId?: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  role?: string | null;
  spaceId?: string | null;
}

type AppIndexItem =
  | { kind: 'app'; id: string; name: string; description: string; version: string; status: string; icon: string | null; domainId: string | null }
  | { kind: 'logic'; id: string; name: string; status: string; domainId: string | null };

export function AppsPage() {
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppRecord[]>(() => peekCached<{ data: AppRecord[] }>('/v1/apps')?.data ?? []);
  const [workflows, setWorkflows] = useState<WorkflowRow[]>(() => peekCached<{ workflows: WorkflowRow[] }>('/v1/workflows')?.workflows ?? []);
  const [domains, setDomains] = useState<DomainRow[]>(() => peekCached<{ data: DomainRow[] }>('/v1/domains')?.data ?? []);
  const [agents, setAgents] = useState<AgentRow[]>(() => peekCached<{ agents: AgentRow[] }>('/v1/agents')?.agents ?? []);
  // Revisits paint from cache instantly; only a cold load shows the spinner.
  const [loading, setLoading] = useState(() => peekCached('/v1/apps') === undefined);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [templateId, setTemplateId] = useState('blank');
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [domainFilter, setDomainFilter] = useState<DomainToolbarSelection>('all');
  const [engineAppId, setEngineAppId] = useState<string | null>(null);
  const [engineSurfaces, setEngineSurfaces] = useState<AppSurface[]>([]);
  // Extensions are a shared workflow-building block, not a top-level destination,
  // so they open as a modal from here (the apps/workflows hub) and from each
  // workflow canvas toolbar â€” never a standalone sidebar page.
  const [extensionsOpen, setExtensionsOpen] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importEnvelope, setImportEnvelope] = useState<AppManifestEnvelope | null>(null);
  const [importPreview, setImportPreview] = useState<AppInstallPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importAcknowledged, setImportAcknowledged] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function refresh() {
    // Silent revalidation when cached data is already on screen.
    if (peekCached('/v1/apps') === undefined) setLoading(true);
    setError(null);
    try {
      // Apps + workflows are the index itself; domains + agents are auxiliary
      // metadata (grouping + owner labels), so a failure there must never blank
      // the page â€” it just degrades to an ungrouped list.
      const [appRows, workflowRows] = await Promise.all([
        appsApi.list(),
        apiCached<{ workflows: WorkflowRow[] }>('/v1/workflows').then((r) => r.workflows ?? []),
      ]);
      const [domainRows, agentRows] = await Promise.all([
        apiCached<{ data: DomainRow[] }>('/v1/domains').then((r) => r.data ?? []).catch(() => [] as DomainRow[]),
        apiCached<{ agents: AgentRow[] }>('/v1/agents').then((r) => r.agents ?? []).catch(() => [] as AgentRow[]),
      ]);
      setApps(appRows);
      setWorkflows(workflowRows);
      setDomains(domainRows);
      setAgents(agentRows);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const resolveDomainId = (itemDomainId: string | null | undefined, ownerAgentId: string | null | undefined) => {
    if (itemDomainId) return itemDomainId;
    if (!ownerAgentId) return null;
    const managedDomain = domains.find((d) => d.managerId === ownerAgentId);
    if (managedDomain) return managedDomain.id;
    const ownerAgent = agents.find((a) => a.id === ownerAgentId);
    return ownerAgent?.spaceId ?? null;
  };

  const appIds = new Set(apps.map((a) => a.id));
  const items: AppIndexItem[] = [
    ...apps.map((app): AppIndexItem => ({
      kind: 'app',
      id: app.id,
      name: app.name,
      description: app.description || 'Interface, logic, data, and memory in one App.',
      version: app.version,
      status: app.status,
      icon: app.icon,
      domainId: resolveDomainId(app.domainId, app.ownerAgentId),
    })),
    ...workflows
      .filter((wf) => !wf.appId || !appIds.has(wf.appId))
      .map((wf): AppIndexItem => ({ kind: 'logic', id: wf.id, name: wf.title, status: wf.status ?? 'idle', domainId: resolveDomainId(wf.spaceId, wf.ownerAgentId) })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const q = query.trim().toLowerCase();
  const searched = q ? items.filter((item) => item.name.toLowerCase().includes(q)) : items;
  const filtered = searched.filter((item) => {
    if (domainFilter === 'all') return true;
    if (domainFilter === 'unassigned') return !item.domainId;
    return item.domainId === domainFilter;
  });
  const countForDomain = (domainId: string | null) =>
    searched.filter((item) => (domainId === null ? !item.domainId : item.domainId === domainId)).length;
  const domainById = new Map(domains.map((domain) => [domain.id, domain]));
  const managerName = (domainId: string) => {
    const managerId = domainById.get(domainId)?.managerId;
    return managerId ? agents.find((agent) => agent.id === managerId)?.name ?? null : null;
  };

  // Domain-grouped sections: each top-level Domain followed by its Subdomains,
  // then an Unassigned bucket â€” mirrors the workflows page's visual separation.
  const sections = buildDomainSections(filtered, domains);
  const engineApp = apps.find((app) => app.id === engineAppId) ?? null;

  async function createApp() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const template = APP_TEMPLATES.find((t) => t.id === templateId);
      const app = await appsApi.create({
        name: trimmed,
        createEntryWorkflow: true,
        ...(template?.graph ? { entryWorkflowGraph: template.graph } : {}),
      });
      setName('');
      setTemplateId('blank');
      setCreateOpen(false);
      navigate(`/apps/${app.id}?facet=workflow`);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  async function previewImportFile(file: File) {
    setImportBusy(true);
    setImportError(null);
    setImportPreview(null);
    setImportEnvelope(null);
    setImportAcknowledged(false);
    try {
      const envelope = JSON.parse(await file.text()) as AppManifestEnvelope;
      const preview = await appsApi.previewImport(envelope);
      setImportEnvelope(envelope);
      setImportPreview(preview);
      setImportOpen(true);
    } catch (e) {
      setImportError(apiErrorMessage(e));
      setImportOpen(true);
    } finally {
      setImportBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function installImport() {
    if (!importEnvelope || !importPreview || importBusy || !importAcknowledged) return;
    setImportBusy(true);
    setImportError(null);
    try {
      const installed = await appsApi.importApp(importEnvelope, importPreview.permissions);
      setImportOpen(false);
      setImportEnvelope(null);
      setImportPreview(null);
      setImportAcknowledged(false);
      await refresh();
      navigate(`/apps/${installed.appId}`);
    } catch (e) {
      setImportError(apiErrorMessage(e));
    } finally {
      setImportBusy(false);
    }
  }

  async function open(item: AppIndexItem) {
    if (openingId) return;
    if (item.kind === 'app') {
      navigate(`/apps/${item.id}`);
      return;
    }
    setOpeningId(item.id);
    setError(null);
    try {
      const app = await appsApi.promoteWorkflow(item.id);
      navigate(`/apps/${app.id}?facet=workflow`);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setOpeningId(null);
    }
  }

  async function openAppEngine(appId: string) {
    setEngineAppId(appId);
    setEngineSurfaces([]);
    setError(null);
    try {
      setEngineSurfaces(await appsApi.listSurfaces(appId));
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  async function saveAppSettings(patch: AppUpdatePayload): Promise<AppRecord> {
    if (!engineApp) throw new Error('No app selected');
    const updated = await appsApi.update(engineApp.id, patch);
    setApps((current) => current.map((app) => (app.id === updated.id ? updated : app)));
    return updated;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-6 py-4">
        <div className="mr-auto">
          <h1 className="text-display text-text-primary">Apps</h1>
          <p className="mt-0.5 text-[12px] text-text-muted">{items.length} {items.length === 1 ? 'app' : 'apps'}</p>
        </div>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Searchâ€¦"
            className="h-9 w-56 rounded-input border border-line bg-canvas pl-9 pr-3 text-[13px] text-text-primary outline-none focus:border-accent"
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".agentisapp,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void previewImportFile(file);
          }}
        />
        <button
          type="button"
          onClick={() => setExtensionsOpen(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-canvas px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          title="Manage the code extensions your workflows can call"
        >
          <Puzzle size={13} /> Extensions
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-canvas px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary"
        >
          {importBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Import
        </button>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover"
        >
          <Plus size={13} /> New app
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-6 py-3">
        <DomainToolbar
          domains={domains}
          selected={domainFilter}
          onSelect={setDomainFilter}
          totalCount={searched.length}
          countForDomain={countForDomain}
          allLabel="All domains"
          unassignedLabel="Unassigned"
        />
        <span className="text-[12px] text-text-muted">Organize apps by domain â€” the manager who owns each is shown on its section.</span>
      </div>

      <main className="min-h-0 flex-1 overflow-auto p-6">
        {error ? <div className="mb-4 rounded-card border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</div> : null}

        {loading ? (
          <div className="flex h-48 items-center justify-center text-text-muted"><Loader2 className="animate-spin" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center rounded-card border border-dashed border-line text-center text-text-muted">
            <LayoutGrid size={34} className="mb-3" />
            <div className="text-[14px] font-medium text-text-secondary">No apps yet</div>
            <button type="button" onClick={() => setCreateOpen(true)} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover">
              <Plus size={13} /> New app
            </button>
          </div>
        ) : (
          <div className="space-y-7">
            {sections.map((section) => (
              <section key={section.key}>
                <div className="mb-3 flex items-center gap-2">
                  {section.colorHex ? (
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: section.colorHex }} />
                  ) : (
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-line" />
                  )}
                  <h2 className="text-[13px] font-semibold text-text-primary">{section.label}</h2>
                  {section.domainId && managerName(section.domainId) ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas px-2 py-0.5 text-[10px] text-text-muted">
                      <Users size={10} /> {managerName(section.domainId)}
                    </span>
                  ) : null}
                  <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">{section.items.length}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {section.items.map((item) => (
                    <AppCard
                      key={`${item.kind}:${item.id}`}
                      item={item}
                      opening={openingId === item.id}
                      onOpen={() => void open(item)}
                      onOpenSettings={item.kind === 'app' ? () => void openAppEngine(item.id) : undefined}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {importOpen && (
        <ImportDialog
          preview={importPreview}
          error={importError}
          busy={importBusy}
          acknowledged={importAcknowledged}
          onAcknowledge={setImportAcknowledged}
          onPickFile={() => fileInputRef.current?.click()}
          onInstall={() => void installImport()}
          onClose={() => { if (!importBusy) setImportOpen(false); }}
        />
      )}
      {createOpen && (
        <CreateAppDialog
          name={name}
          busy={creating}
          templateId={templateId}
          onTemplateChange={setTemplateId}
          onNameChange={setName}
          onCreate={() => void createApp()}
          onClose={() => { if (!creating) setCreateOpen(false); }}
        />
      )}
      <AppEngineModal
        open={Boolean(engineApp)}
        app={engineApp}
        surfaces={engineSurfaces}
        domains={domains as AppEngineDomain[]}
        agents={agents as AppEngineAgent[]}
        onClose={() => setEngineAppId(null)}
        onSave={saveAppSettings}
      />
      {extensionsOpen && <ExtensionsModal onClose={() => setExtensionsOpen(false)} />}
    </div>
  );
}

interface DomainSection {
  key: string;
  domainId: string | null;
  label: string;
  colorHex?: string | null;
  items: AppIndexItem[];
}

/**
 * Group index items into domain sections â€” each top-level Domain followed by its
 * Subdomains (labelled "Parent â€º Sub"), then an Unassigned bucket. Empty domains
 * are omitted so the page only shows sections that actually hold apps.
 */
function buildDomainSections(items: AppIndexItem[], domains: DomainRow[]): DomainSection[] {
  const byDomain = new Map<string, AppIndexItem[]>();
  const unassigned: AppIndexItem[] = [];
  for (const item of items) {
    if (!item.domainId) {
      unassigned.push(item);
      continue;
    }
    (byDomain.get(item.domainId) ?? byDomain.set(item.domainId, []).get(item.domainId)!).push(item);
  }

  const sections: DomainSection[] = [];
  const tops = domains.filter((domain) => !domain.parentDomainId);
  for (const top of tops) {
    const topItems = byDomain.get(top.id) ?? [];
    if (topItems.length > 0) {
      sections.push({ key: top.id, domainId: top.id, label: top.name, colorHex: top.colorHex, items: topItems });
    }
    for (const sub of domains.filter((domain) => domain.parentDomainId === top.id)) {
      const subItems = byDomain.get(sub.id) ?? [];
      if (subItems.length > 0) {
        sections.push({ key: sub.id, domainId: sub.id, label: `${top.name} â€º ${sub.name}`, colorHex: sub.colorHex, items: subItems });
      }
    }
  }
  if (unassigned.length > 0) {
    sections.push({ key: 'unassigned', domainId: null, label: 'Unassigned', colorHex: null, items: unassigned });
  }
  return sections;
}

function AppCard({
  item,
  opening,
  onOpen,
  onOpenSettings,
}: {
  item: AppIndexItem;
  opening: boolean;
  onOpen: () => void;
  onOpenSettings?: () => void;
}) {
  const isLogic = item.kind === 'logic';
  return (
    <article
      className="group relative rounded-card border border-line bg-surface p-4 text-left shadow-card transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <div className="flex items-start gap-3">
        <span className={clsx('flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-card border', isLogic ? 'border-accent/20 bg-accent-soft text-accent' : 'border-line bg-canvas text-text-secondary')}>
          {isLogic ? (
            <Workflow size={17} />
          ) : item.kind === 'app' && item.icon ? (
            item.icon.startsWith('http://') || item.icon.startsWith('https://') || item.icon.startsWith('data:image/') ? (
              <img src={item.icon} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-[18px]">{item.icon}</span>
            )
          ) : (
            <Boxes size={17} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpen}
              disabled={opening}
              className="min-w-0 truncate rounded-md text-left text-[14px] font-semibold text-text-primary group-hover:text-accent disabled:opacity-50 after:absolute after:inset-0 after:rounded-[inherit]"
            >
              {item.name}
            </button>
            <span className="shrink-0 rounded-full border border-line bg-canvas px-2 py-0.5 text-[10px] text-text-muted">{isLogic ? 'workflow' : item.status}</span>
            {onOpenSettings ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="relative z-10 ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-80 transition-colors hover:bg-canvas hover:text-text-primary group-hover:opacity-100"
                title="App engine"
                aria-label={`App engine ${item.name}`}
              >
                <Settings size={13} />
              </button>
            ) : null}
          </div>
          {item.kind === 'app' ? (
            <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-text-muted">{item.description}</p>
          ) : (
            <p className="mt-1 text-[12px] text-text-muted">Open to make this workflow an App-of-one.</p>
          )}
        </div>
      </div>
      {opening ? <div className="mt-3 flex items-center gap-1.5 text-[11px] text-text-muted"><Loader2 size={12} className="animate-spin" /> Opening...</div> : null}
    </article>
  );
}


function CreateAppDialog({
  name,
  busy,
  templateId,
  onTemplateChange,
  onNameChange,
  onCreate,
  onClose,
}: {
  name: string;
  busy: boolean;
  templateId: string;
  onTemplateChange: (id: string) => void;
  onNameChange: (name: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/70 p-4 backdrop-blur-sm">
      <form
        className="w-full max-w-md rounded-card border border-line bg-surface shadow-xl"
        onSubmit={(event) => { event.preventDefault(); onCreate(); }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <div className="text-[14px] font-semibold text-text-primary">New app</div>
            <div className="mt-0.5 text-[12px] text-text-muted">Starts with an empty workflow canvas.</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-btn p-1 text-text-muted hover:bg-canvas hover:text-text-primary" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="p-4">
          <label className="block text-[12px] font-medium text-text-secondary" htmlFor="new-app-name">Name</label>
          <input
            id="new-app-name"
            autoFocus
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="Store outreach"
            className="mt-1.5 h-9 w-full rounded-input border border-line bg-canvas px-3 text-[13px] text-text-primary outline-none focus:border-accent"
          />
          <div className="mt-4 text-[12px] font-medium text-text-secondary">Start from</div>
          <div className="mt-1.5 grid grid-cols-1 gap-1.5">
            {APP_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onTemplateChange(template.id)}
                className={clsx(
                  'rounded-btn border px-3 py-2 text-left transition-colors',
                  templateId === template.id ? 'border-accent bg-accent/5' : 'border-line hover:bg-canvas',
                )}
              >
                <div className="text-[12px] font-medium text-text-primary">{template.name}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-text-muted">{template.description}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={onClose} className="h-8 rounded-btn px-3 text-[12px] text-text-muted hover:bg-canvas hover:text-text-primary">Cancel</button>
          <button type="submit" disabled={!name.trim() || busy} className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create app
          </button>
        </div>
      </form>
    </div>
  );
}

function ImportDialog({
  preview, error, busy, acknowledged, onAcknowledge, onPickFile, onInstall, onClose,
}: {
  preview: AppInstallPreview | null;
  error: string | null;
  busy: boolean;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  onPickFile: () => void;
  onInstall: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-card border border-line bg-surface shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <div className="text-[14px] font-semibold text-text-primary">Install Agentic App</div>
            <div className="mt-0.5 text-[12px] text-text-muted">Review the package before it enters this workspace.</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-btn p-1 text-text-muted hover:bg-canvas hover:text-text-primary" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="max-h-[70vh] overflow-auto px-4 py-4">
          {error ? <div className="rounded-card border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</div> : null}
          {preview ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-line bg-canvas text-text-secondary">
                  {preview.identity.icon ? <span>{preview.identity.icon}</span> : <Download size={16} />}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold text-text-primary">{preview.identity.name}</div>
                  <div className="mt-0.5 text-[12px] text-text-muted">{preview.identity.slug} Â· v{preview.identity.version}</div>
                  <div className="mt-1 truncate font-mono text-[10px] text-text-muted">sha256:{preview.checksum}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Metric label="Logic" value={preview.counts.workflows} />
                <Metric label="Surfaces" value={preview.counts.surfaces} />
                <Metric label="Collections" value={preview.counts.collections} />
                <Metric label="Capabilities" value={preview.counts.capabilities} />
              </div>
              <Chips title="Permissions" items={preview.permissions} empty="No elevated permissions" />
              {preview.requiredPlugins.length > 0 && <Chips title="Required plugins" items={preview.requiredPlugins} empty="" />}
              {preview.warnings.length > 0 && (
                <div className="rounded-card border border-warn/30 bg-warn/10 px-3 py-2">
                  <div className="mb-1 text-[11px] font-semibold uppercase text-warn">Review</div>
                  <ul className="space-y-1 text-[12px] text-text-secondary">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                </div>
              )}
              <label className="flex items-start gap-2 rounded-card border border-line bg-canvas px-3 py-2 text-[12px] text-text-secondary">
                <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.currentTarget.checked)} className="mt-0.5 h-4 w-4 rounded border-line bg-surface text-accent" />
                <span>I acknowledge this package's permissions and security scan results.</span>
              </label>
            </div>
          ) : !error ? (
            <div className="flex h-36 items-center justify-center text-text-muted"><Loader2 className="animate-spin" /></div>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={onPickFile} className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line px-2.5 text-[12px] text-text-secondary hover:bg-canvas"><Upload size={13} /> Choose file</button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="h-8 rounded-btn px-3 text-[12px] text-text-muted hover:bg-canvas hover:text-text-primary">Cancel</button>
            <button type="button" onClick={onInstall} disabled={!preview || !acknowledged || busy} className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Install
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-line bg-canvas px-3 py-2">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="mt-0.5 text-[17px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function Chips({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase text-text-muted">{title}</div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">{items.map((i) => <span key={i} className="rounded-full border border-line bg-canvas px-2 py-0.5 text-[11px] text-text-secondary">{i}</span>)}</div>
      ) : <div className="text-[12px] text-text-muted">{empty}</div>}
    </div>
  );
}



