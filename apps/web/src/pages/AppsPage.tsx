/**
 * AppsPage — the Agentic App index. One primitive: every item is an App.
 *
 * Clean list, like the workflows page it replaces: search, import, a single
 * "New app" create, and a grid. Opening an App goes to the unified editor
 * (`/apps/:id`). A legacy bare workflow is promoted transactionally to an
 * App-of-one when opened, so every detail page has the same App contract.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  Boxes,
  ChevronDown,
  Download,
  LayoutGrid,
  Loader2,
  Plus,
  Puzzle,
  Search,
  Settings,
  Trash2,
  Upload,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import type { AppInstallPreview, AppManifestEnvelope, AppRecord, AppSurface } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { appsApi, type AppUpdatePayload } from '../lib/appsApi';
import { APP_TEMPLATES } from '../lib/appTemplates';
import { api, apiCached, peekCached, apiErrorMessage } from '../lib/api';
import { AppEngineModal, type AppEngineAgent, type AppEngineDomain } from '../components/apps/AppEngineModal';
import { ExtensionsModal } from '../components/extensions/ExtensionsModal';
import { DomainToolbar, nestedDomainOptions, type DomainToolbarSelection } from '../components/shared/DomainToolbar';
import { DomainEditorSheet, type DomainOption, type DomainManagerOption } from '../components/agents/DomainEditorSheet';
import { InfoHint } from '../components/shared/InfoHint';

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
  const [createDomainId, setCreateDomainId] = useState('');
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [domainFilter, setDomainFilter] = useState<DomainToolbarSelection>('all');
  const [engineAppId, setEngineAppId] = useState<string | null>(null);
  const [engineSurfaces, setEngineSurfaces] = useState<AppSurface[]>([]);
  // Extensions are a shared workflow-building block, not a top-level destination,
  // so they open as a modal from here (the apps/workflows hub) and from each
  // workflow canvas toolbar — never a standalone sidebar page.
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  // Header controls mirror the Agents page: collapsible search + a "New app"
  // split button whose dropdown holds Import.
  const [searchOpen, setSearchOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement | null>(null);

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
      // the page — it just degrades to an ungrouped list.
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

  // Live-refresh the apps + workflows grid when an AGENT (or anyone) creates,
  // deletes, or restructures an App/workflow — otherwise a deleted app lingers
  // until a manual reload, and an agent's new app never appears. The workspace
  // room carries these (App/workflow mutations dual-publish there).
  useEffect(() => rtSubscribe('workspace', {}), []);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useRealtime(
    useMemo(() => [
      REALTIME_EVENTS.APP_CREATED, REALTIME_EVENTS.APP_UPDATED, REALTIME_EVENTS.APP_DELETED,
      REALTIME_EVENTS.WORKFLOW_CREATED, REALTIME_EVENTS.WORKFLOW_DELETED,
    ], []),
    () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => { void refresh(); }, 400);
    },
  );
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  useEffect(() => {
    if (!newMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!newMenuRef.current?.contains(event.target as Node)) setNewMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setNewMenuOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [newMenuOpen]);

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
  // then an Unassigned bucket — mirrors the workflows page's visual separation.
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
        ...(createDomainId ? { domainId: createDomainId } : {}),
        ...(template?.graph ? { entryWorkflowGraph: template.graph } : {}),
      });
      setName('');
      setTemplateId('blank');
      setCreateDomainId('');
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

  /**
   * Delete a standalone workflow. Only reachable for `kind: 'logic'` items —
   * an App's workflows are managed from the App editor and go with the App.
   */
  async function deleteWorkflow(workflowId: string, title: string) {
    if (!window.confirm(
      `Delete "${title}" permanently?\n\nThis also removes its run history. This cannot be undone.`,
    )) return;
    setError(null);
    try {
      await api(`/v1/workflows/${workflowId}`, { method: 'DELETE' });
      // Drop it locally so the card disappears immediately; the realtime
      // WORKFLOW_DELETED subscription reconciles anything this misses.
      setWorkflows((rows) => rows.filter((row) => row.id !== workflowId));
    } catch (e) {
      setError(apiErrorMessage(e));
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
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-9 items-center gap-1 rounded-lg border border-line bg-surface-2/90 px-1 backdrop-blur-md">
            {searchOpen ? (
              <div className="flex items-center gap-1.5 pl-1.5">
                <Search size={14} className="shrink-0 text-text-muted" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onBlur={() => { if (!query.trim()) setSearchOpen(false); }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}
                  placeholder="Search apps…"
                  aria-label="Search apps"
                  className="w-40 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
                />
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => { setQuery(''); setSearchOpen(false); }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-3 hover:text-text-primary"
                >
                  <X size={13} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label="Search apps"
                onClick={() => setSearchOpen(true)}
                className={clsx(
                  'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface-3',
                  query.trim() ? 'text-accent' : 'text-text-muted hover:text-text-primary',
                )}
              >
                <Search size={15} />
              </button>
            )}
            <span className="h-4 w-px shrink-0 bg-line" />
            <DomainToolbar
              embedded
              domains={domains}
              selected={domainFilter}
              onSelect={setDomainFilter}
              totalCount={searched.length}
              countForDomain={countForDomain}
              allLabel="All domains"
              unassignedLabel="Unassigned"
            />
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setExtensionsOpen(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface-2/90 px-3 text-[12px] font-medium text-text-secondary backdrop-blur-md hover:bg-surface-3 hover:text-text-primary"
            title="Manage the code extensions your workflows can call"
          >
            <Puzzle size={13} /> Extensions
          </button>
          <div ref={newMenuRef} className="relative flex items-center">
            <button
              type="button"
              onClick={() => setNewMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              className="inline-flex h-9 items-center gap-1.5 rounded-l-lg bg-accent pl-3 pr-2.5 text-[12px] font-semibold text-canvas hover:bg-accent-hover"
            >
              <Plus size={14} /> New app
            </button>
            <button
              type="button"
              onClick={() => setNewMenuOpen((open) => !open)}
              aria-label="More create options"
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              className="inline-flex h-9 items-center rounded-r-lg border-l border-canvas/25 bg-accent px-1.5 text-canvas hover:bg-accent-hover"
            >
              <ChevronDown size={14} className={clsx('transition-transform', newMenuOpen && 'rotate-180')} />
            </button>
            {newMenuOpen && (
              <div role="menu" className="absolute right-0 top-[calc(100%+0.4rem)] z-40 w-56 overflow-hidden rounded-card border border-line bg-surface p-1 shadow-dropdown">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setNewMenuOpen(false); setCreateOpen(true); }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                >
                  <Plus size={13} /> New app
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setNewMenuOpen(false); fileInputRef.current?.click(); }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                >
                  {importBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  <span className="min-w-0 flex-1">Import app</span>
                  <InfoHint text="Install a portable .agentisapp package into this workspace." />
                </button>
              </div>
            )}
          </div>
        </div>
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
                      onDelete={item.kind === 'logic' ? () => void deleteWorkflow(item.id, item.name) : undefined}
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
          domains={domains}
          managers={agents.filter((agent) => agent.role === 'manager')}
          domainId={createDomainId}
          onDomainChange={setCreateDomainId}
          onDomainCreated={(domain) => {
            setDomains((current) => [...current.filter((item) => item.id !== domain.id), domain as DomainRow]);
            setCreateDomainId(domain.id);
          }}
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
        onDeleted={(deletedId) => {
          setApps((current) => current.filter((app) => app.id !== deletedId));
          setEngineAppId(null);
        }}
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
 * Group index items into domain sections — each top-level Domain followed by its
 * Subdomains (labelled "Parent › Sub"), then an Unassigned bucket. Empty domains
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
        sections.push({ key: sub.id, domainId: sub.id, label: `${top.name} › ${sub.name}`, colorHex: sub.colorHex, items: subItems });
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
  onDelete,
}: {
  item: AppIndexItem;
  opening: boolean;
  onOpen: () => void;
  onOpenSettings?: () => void;
  onDelete?: () => void;
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
            {/* A standalone workflow has no owning App page, so this card is the
                only place it can be removed from. Without it, a workflow left
                behind by a deleted App is undeletable from the UI entirely. */}
            {onDelete ? (
              <button
                type="button"
                onClick={onDelete}
                className={clsx(
                  'relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:opacity-100 group-hover:opacity-100',
                  !onOpenSettings && 'ml-auto',
                )}
                title="Delete workflow"
                aria-label={`Delete workflow ${item.name}`}
              >
                <Trash2 size={13} />
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
  domains,
  managers,
  domainId,
  onDomainChange,
  onDomainCreated,
  onTemplateChange,
  onNameChange,
  onCreate,
  onClose,
}: {
  name: string;
  busy: boolean;
  templateId: string;
  domains: DomainRow[];
  managers: DomainManagerOption[];
  domainId: string;
  onDomainChange: (id: string) => void;
  onDomainCreated: (domain: DomainOption) => void;
  onTemplateChange: (id: string) => void;
  onNameChange: (name: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [domainEditorOpen, setDomainEditorOpen] = useState(false);
  function handleDomainChange(value: string) {
    if (value === '__create__') setDomainEditorOpen(true);
    else onDomainChange(value);
  }
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
          <label className="mt-4 block text-[12px] font-medium text-text-secondary" htmlFor="new-app-domain">Domain</label>
          <select
            id="new-app-domain"
            value={domainId}
            onChange={(event) => handleDomainChange(event.target.value)}
            className="mt-1.5 h-9 w-full rounded-input border border-line bg-canvas px-3 text-[13px] text-text-primary outline-none focus:border-accent"
          >
            <option value="">Unassigned</option>
            {nestedDomainOptions(domains).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
            <option value="__create__">Create new domain…</option>
          </select>

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
      <DomainEditorSheet
        open={domainEditorOpen}
        managers={managers}
        parentOptions={domains.filter((domain) => !domain.parentDomainId) as DomainOption[]}
        onClose={() => setDomainEditorOpen(false)}
        onSaved={(domain) => {
          setDomainEditorOpen(false);
          if (domain) onDomainCreated(domain);
        }}
      />
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
                  <div className="mt-0.5 text-[12px] text-text-muted">{preview.identity.slug} · v{preview.identity.version}</div>
                  <div className="mt-1 truncate font-mono text-[10px] text-text-muted">sha256:{preview.checksum}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Metric label="Logic" value={preview.counts.workflows} />
                <Metric label="Agents" value={preview.counts.agents} />
                <Metric label="Surfaces" value={preview.counts.surfaces} />
                <Metric label="Collections" value={preview.counts.collections} />
                <Metric label="Knowledge" value={preview.counts.knowledgeDocs} />
                <Metric label="Memories" value={preview.counts.brainAtoms} />
                <Metric label="Data rows" value={preview.counts.collectionRows} />
                <Metric label="Capabilities" value={preview.counts.capabilities} />
              </div>

              {/* What is actually in the package, itemised. Counts alone don't tell
                  an operator which agents arrive, which are reused, or what they
                  will have to reconnect themselves. */}
              {preview.contents.length > 0 && (
                <div className="rounded-card border border-line bg-canvas/45 p-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">What this package contains</div>
                  <div className="max-h-56 space-y-1 overflow-auto">
                    {preview.contents.map((item, i) => (
                      <div key={`${item.kind}-${item.label}-${i}`} className="flex items-start gap-2 text-[12px]">
                        <span className={`mt-0.5 shrink-0 rounded-pill px-1.5 py-0.5 text-[10px] font-medium ${
                          item.action === 'setup' ? 'bg-warn-soft text-warn'
                            : item.action === 'reuse' ? 'bg-surface-2 text-text-muted'
                            : 'bg-accent-soft text-accent'
                        }`}>
                          {item.action === 'setup' ? 'set up' : item.action}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-text-primary">{item.label}</span>
                          <span className="ml-1.5 text-[11px] text-text-muted">{item.kind}</span>
                          {item.detail && <span className="block text-[11px] text-text-muted">{item.detail}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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



