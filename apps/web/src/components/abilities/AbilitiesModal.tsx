/**
 * AbilitiesModal — workspace ability library as a focused modal.
 *
 * Abilities are no longer a sidebar page; they're managed from the Agents page
 * (where they're applied). This modal lists every ability with compile status,
 * and supports create / import / recompile / export / delete inline. Deep
 * editing (specs, examples, knowledge) opens the focused ability editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Zap, Download, Upload, MoreHorizontal, RefreshCw, Trash2, Cpu, AlertTriangle, X, Search, Sparkles } from 'lucide-react';
import { Button, IconButton } from '../shared/Button';
import { EmptyState } from '../shared/EmptyState';
import { Skeleton } from '../shared/Skeleton';
import { StatusBadge } from '../shared/StatusBadge';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { AbilityCompileConfigDrawer } from './AbilityCompileConfigDrawer';
import {
  abilitiesApi,
  compileStatusLabel,
  compileStatusTone,
  downloadAbilityPackage,
  DOMAIN_TAGS,
  ABILITY_DEPTH_LABELS,
  type Ability,
  type AbilityPackage,
  type CompileConfigResponse,
} from '../../lib/abilities';
import { apiErrorMessage } from '../../lib/api';

export function AbilitiesModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [abilities, setAbilities] = useState<Ability[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedDomain, setSelectedDomain] = useState('all');
  const [createPending, setCreatePending] = useState(false);
  const [compileConfig, setCompileConfig] = useState<CompileConfigResponse | null>(null);
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [hubInstallOpen, setHubInstallOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setAbilities((await abilitiesApi.list()).abilities);
    } catch (err) {
      toast.error('Could not load abilities', apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const refreshConfig = useCallback(async () => {
    try { setCompileConfig(await abilitiesApi.getCompileConfig()); } catch { /* best effort */ }
  }, []);

  useEffect(() => { void refresh(); void refreshConfig(); }, [refresh, refreshConfig]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Poll while compiling so badges update live.
  useEffect(() => {
    if (!abilities.some((a) => a.compileStatus === 'compiling')) return;
    const t = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(t);
  }, [abilities, refresh]);

  const existingDomains = useMemo(() => {
    const present = new Set(abilities.map((a) => a.domainTag).filter(Boolean) as string[]);
    return DOMAIN_TAGS.filter((t) => present.has(t.value));
  }, [abilities]);

  const filtered = useMemo(() => {
    let list = selectedDomain === 'all' ? abilities : abilities.filter((a) => a.domainTag === selectedDomain);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((a) => a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q) || (a.domainTag ?? '').toLowerCase().includes(q));
    return list;
  }, [abilities, search, selectedDomain]);

  async function handleCreate() {
    if (createPending) return;
    setCreatePending(true);
    try {
      const { ability } = await abilitiesApi.create({ name: 'Untitled ability', iconEmoji: '⚡', domainTag: 'custom', specs: {}, rulesAlways: [], rulesNever: [], toolHints: [] });
      toast.success('Ability created', ability.name);
      nav(`/abilities/${ability.id}`);
    } catch (err) {
      toast.error('Could not create ability', apiErrorMessage(err));
    } finally {
      setCreatePending(false);
    }
  }

  async function handleImportFile(file: File) {
    try {
      const pkg = JSON.parse(await file.text()) as AbilityPackage;
      const res = await abilitiesApi.import(pkg);
      toast.success('Ability imported', res.ability.name);
      await refresh();
    } catch (err) {
      toast.error('Import failed', apiErrorMessage(err));
    }
  }

  async function handleDelete(ability: Ability) {
    const ok = await confirm({ title: `Delete ${ability.name}?`, body: 'Removes the ability, its examples, and its knowledge. Pinned agents lose access.', confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    try { await abilitiesApi.delete(ability.id); toast.success('Ability deleted', ability.name); await refresh(); }
    catch (err) { toast.error('Delete failed', apiErrorMessage(err)); }
  }

  async function handleRecompile(ability: Ability) {
    try { await abilitiesApi.compile(ability.id); toast.success('Compile queued', ability.name); await refresh(); }
    catch (err) { toast.error('Compile failed', apiErrorMessage(err)); }
  }

  const modelLabel = compileConfig?.workspace?.model ?? compileConfig?.env?.model ?? null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[86vh] max-h-[860px] w-[min(880px,94vw)] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-modal"
      >
        {/* Header — title row + its own actions row so buttons never crowd the title. */}
        <div className="flex flex-col gap-3 border-b border-line px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card border border-amber-400/20 bg-amber-500/10 text-amber-300">
              <Zap size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-text-primary">Abilities</div>
              <div className="truncate text-[11px] text-text-muted">Workspace specialists every agent can use automatically — like LoRA add-ons, but pure behavior.</div>
            </div>
            <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={compileConfig && !compileConfig.hasModel ? 'danger' : 'secondary'}
              size="sm"
              iconLeft={compileConfig && !compileConfig.hasModel ? <AlertTriangle size={13} /> : <Cpu size={13} />}
              onClick={() => setConfigDrawerOpen(true)}
            >
              {modelLabel ? `Model: ${modelLabel}` : 'Template mode'}
            </Button>
            <Button variant="secondary" size="sm" iconLeft={<Download size={13} />} onClick={() => importInputRef.current?.click()}>Import</Button>
            <Button variant="secondary" size="sm" iconLeft={<Zap size={13} />} onClick={() => setHubInstallOpen(true)}>Hub Install</Button>
            <div className="flex-1" />
            <Button variant="secondary" size="sm" iconLeft={<Sparkles size={13} />} onClick={() => setDraftOpen(true)} disabled={createPending}>Create with AI</Button>
            <Button variant="primary" size="sm" iconLeft={<Plus size={13} />} onClick={handleCreate} loading={createPending} disabled={createPending}>New ability</Button>
          </div>
          <input ref={importInputRef} type="file" accept=".ability,.json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportFile(f); e.target.value = ''; }} />
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-2 border-b border-line px-5 py-3">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-2.5 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, description, or domain"
              className="w-full rounded-input border border-line bg-surface-2 py-2 pl-8 pr-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>
          {existingDomains.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {[{ value: 'all', label: 'All' }, ...existingDomains].map((tag) => (
                <button
                  key={tag.value}
                  type="button"
                  onClick={() => setSelectedDomain(tag.value)}
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${selectedDomain === tag.value ? 'border-accent/30 bg-accent/15 text-accent' : 'border-line bg-surface text-text-muted hover:text-text-primary'}`}
                >
                  {tag.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-card" />)}</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Zap size={36} />}
              title={search.trim() ? 'No matching abilities' : 'No abilities yet'}
              body={search.trim() ? 'Try a different search, or create the ability you need.' : 'Compiled behavioral specializations for any agent. Define specs, add knowledge and examples — compile once, share workspace-wide.'}
              primaryAction={<Button variant="primary" iconLeft={<Plus size={14} />} onClick={handleCreate} loading={createPending} disabled={createPending}>Create your first ability</Button>}
              variant="inline"
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {filtered.map((ability) => (
                <li key={ability.id}>
                  <AbilityRow
                    ability={ability}
                    onOpen={() => { onClose(); nav(`/abilities/${ability.id}`); }}
                    onRecompile={() => handleRecompile(ability)}
                    onDelete={() => handleDelete(ability)}
                    onExport={async () => {
                      try { downloadAbilityPackage(await abilitiesApi.export(ability.id), ability.slug); toast.success('Ability exported', `${ability.name}.ability`); }
                      catch (err) { toast.error('Export failed', apiErrorMessage(err)); }
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {draftOpen && (
        <DraftWithAIDialog
          onClose={() => setDraftOpen(false)}
          onDrafted={(id) => { setDraftOpen(false); onClose(); nav(`/abilities/${id}`); }}
        />
      )}
      {hubInstallOpen && (
        <HubInstallDialog onClose={() => setHubInstallOpen(false)} onInstalled={() => { setHubInstallOpen(false); void refresh(); }} />
      )}
      <AbilityCompileConfigDrawer open={configDrawerOpen} onClose={() => setConfigDrawerOpen(false)} onSaved={() => { void refreshConfig(); }} />
    </div>
  );
}

/**
 * DraftWithAIDialog — the 10x creation engine's on-ramps, inline. Describe an
 * outcome, paste examples, or drop in material → a finished, compiling specialist
 * in seconds, at zero cost (reuses the workspace model; deterministic fallback
 * when none is configured).
 */
type DraftMode = 'intent' | 'examples' | 'material';

function DraftWithAIDialog({ onClose, onDrafted }: { onClose: () => void; onDrafted: (id: string) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<DraftMode>('intent');
  const [intent, setIntent] = useState('');
  const [material, setMaterial] = useState('');
  const [materialTitle, setMaterialTitle] = useState('');
  const [pairs, setPairs] = useState<Array<{ inputText: string; outputText: string }>>([
    { inputText: '', outputText: '' },
    { inputText: '', outputText: '' },
  ]);
  const [busy, setBusy] = useState(false);

  const validPairs = pairs.filter((p) => p.inputText.trim() && p.outputText.trim());
  const canSubmit =
    mode === 'intent' ? intent.trim().length > 0
      : mode === 'material' ? material.trim().length > 0
        : validPairs.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      const body =
        mode === 'intent' ? { from: 'intent' as const, intent: intent.trim() }
          : mode === 'material' ? { from: 'material' as const, material: material.trim(), materialTitle: materialTitle.trim() || undefined }
            : { from: 'examples' as const, examples: validPairs };
      const res = await abilitiesApi.draft(body);
      toast.success(res.synthesized ? 'Specialist drafted' : 'Starter draft created', res.notes[0] ?? res.ability.name);
      onDrafted(res.ability.id);
    } catch (err) {
      toast.error('Could not draft ability', apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const tabs: Array<{ id: DraftMode; label: string; hint: string }> = [
    { id: 'intent', label: 'Describe', hint: 'One line about the specialist you want' },
    { id: 'examples', label: 'From examples', hint: 'Paste input → output pairs; we infer the spec' },
    { id: 'material', label: 'From material', hint: 'Drop in docs/guidelines; we distill the rules' },
  ];
  const activeTab = tabs.find((t) => t.id === mode)!;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-card border border-line bg-surface shadow-modal animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between border-b border-line bg-surface-2 px-5 py-3">
          <div className="flex items-center gap-2 text-text-primary">
            <Sparkles size={16} className="text-accent" />
            <h2 className="text-[14px] font-medium">Create with AI</h2>
          </div>
          <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
        </div>

        <div className="flex flex-col gap-4 p-5">
          {/* On-ramp tabs */}
          <div className="flex gap-1.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setMode(t.id)}
                className={`flex-1 rounded-input border px-2 py-1.5 text-[11px] font-medium transition-colors ${mode === t.id ? 'border-accent/40 bg-accent/15 text-accent' : 'border-line bg-surface text-text-muted hover:text-text-primary'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="-mt-2 text-[11px] text-text-muted">{activeTab.hint}.</p>

          {mode === 'intent' && (
            <textarea
              autoFocus
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              rows={3}
              placeholder='e.g. "Draft SOC2-aware security review comments for pull requests"'
              className="w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          )}

          {mode === 'material' && (
            <div className="flex flex-col gap-2">
              <input
                value={materialTitle}
                onChange={(e) => setMaterialTitle(e.target.value)}
                placeholder="Source title (optional) — e.g. Brand Voice Guide"
                className="w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <textarea
                autoFocus
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
                rows={6}
                placeholder="Paste docs, guidelines, a transcript, or brand rules…"
                className="w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </div>
          )}

          {mode === 'examples' && (
            <div className="flex flex-col gap-2">
              {pairs.map((p, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="grid flex-1 grid-cols-2 gap-2">
                    <input
                      value={p.inputText}
                      onChange={(e) => setPairs((ps) => ps.map((x, j) => (j === i ? { ...x, inputText: e.target.value } : x)))}
                      placeholder="Input / task"
                      className="rounded-input border border-line bg-surface-2 px-2.5 py-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                    />
                    <input
                      value={p.outputText}
                      onChange={(e) => setPairs((ps) => ps.map((x, j) => (j === i ? { ...x, outputText: e.target.value } : x)))}
                      placeholder="Ideal output"
                      className="rounded-input border border-line bg-surface-2 px-2.5 py-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                    />
                  </div>
                  {pairs.length > 1 && (
                    <IconButton icon={<Trash2 size={13} />} label="Remove pair" size="sm" onClick={() => setPairs((ps) => ps.filter((_, j) => j !== i))} />
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setPairs((ps) => [...ps, { inputText: '', outputText: '' }])}
                className="self-start text-[11px] font-medium text-accent hover:underline"
              >
                + Add example
              </button>
            </div>
          )}

          <p className="text-[11px] text-text-muted">Zero-cost — runs on your workspace model (or a deterministic starter when none is set). You can refine it after.</p>
        </div>

        <div className="flex justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" iconLeft={<Sparkles size={14} />} loading={busy} disabled={!canSubmit || busy}>
            Create specialist
          </Button>
        </div>
      </form>
    </div>
  );
}

function HubInstallDialog({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
  const toast = useToast();
  const [hubSlug, setHubSlug] = useState('');
  const [installing, setInstalling] = useState(false);

  async function handleInstall(e: React.FormEvent) {
    e.preventDefault();
    if (!hubSlug.trim()) return;
    setInstalling(true);
    try {
      await abilitiesApi.hubInstall(hubSlug.trim());
      toast.success('Ability installed', `Successfully pulled ${hubSlug}`);
      onInstalled();
    } catch (err) {
      toast.error('Install failed', apiErrorMessage(err));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm" onClick={onClose}>
      <form
        onSubmit={handleInstall}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-card border border-line bg-surface shadow-modal animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3 bg-surface-2">
          <div className="flex items-center gap-2 text-text-primary">
            <Zap size={16} className="text-accent" />
            <h2 className="text-[14px] font-medium">Install from AgentisHub</h2>
          </div>
          <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
        </div>
        <div className="p-5 flex flex-col gap-4">
          <p className="text-[12px] text-text-muted">
            Enter the package slug to pull an official ability from AgentisHub.
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-text-secondary">Hub Slug</label>
            <input
              autoFocus
              value={hubSlug}
              onChange={(e) => setHubSlug(e.target.value)}
              placeholder="e.g. nexseed/react-expert"
              className="w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={installing} disabled={!hubSlug.trim() || installing}>
            Install
          </Button>
        </div>
      </form>
    </div>
  );
}

function AbilityRow({ ability, onOpen, onRecompile, onExport, onDelete }: {
  ability: Ability;
  onOpen: () => void;
  onRecompile: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const tone = compileStatusTone(ability.compileStatus);
  const badgeTone = tone === 'green' ? 'accent' : tone === 'amber' ? 'warn' : tone === 'red' ? 'danger' : 'muted';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-surface-2 text-lg">{ability.iconEmoji ?? '⚡'}</span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[13px] font-medium text-text-primary">{ability.name}</h3>
        <div className="mt-0.5 flex items-center gap-2 truncate text-[11px] text-text-muted">
          <span className="truncate">{ability.description?.trim() || 'No description'}</span>
          {ability.domainTag && (<><span>·</span><span className="capitalize">{ability.domainTag.replace(/_/g, ' ')}</span></>)}
          {ability.depth && (<><span>·</span><span className="rounded-full border border-line bg-surface-2 px-1.5 text-[10px] text-text-secondary">{ABILITY_DEPTH_LABELS[ability.depth]}</span></>)}
          <span>·</span>
          <span>{ability.exampleCount} ex · {ability.knowledgeCount} refs</span>
        </div>
      </div>
      <StatusBadge tone={badgeTone as 'accent' | 'warn' | 'danger' | 'muted'} label={compileStatusLabel(ability.compileStatus)} pulse={ability.compileStatus === 'compiling'} />
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <IconButton icon={<MoreHorizontal size={14} />} label="More actions" size="sm" onClick={() => setMenuOpen((v) => !v)} />
        {menuOpen && (
          <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown" onMouseLeave={() => setMenuOpen(false)}>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary" onClick={() => { setMenuOpen(false); onRecompile(); }}><RefreshCw size={12} /> Recompile</button>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary" onClick={() => { setMenuOpen(false); onExport(); }}><Upload size={12} /> Export .ability</button>
            <button type="button" className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-[12px] text-danger hover:bg-danger-soft" onClick={() => { setMenuOpen(false); onDelete(); }}><Trash2 size={12} /> Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}
