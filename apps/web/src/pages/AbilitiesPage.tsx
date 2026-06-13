/**
 * AbilitiesPage — workspace ability library + creation wizard.
 *
 * One sidebar item. Lists every ability in the workspace, surfaces compile
 * status, and lets the operator create a new one through a focused drawer
 * wizard. Selecting a row opens the detail page where examples, knowledge,
 * compile, and export flows live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Zap, Upload, Download, MoreHorizontal, AlertTriangle, RefreshCw, Trash2, Cpu, Sparkles } from 'lucide-react';
import { PageHeader } from '../components/shared/PageHeader';
import { Button, IconButton } from '../components/shared/Button';
import { EmptyState } from '../components/shared/EmptyState';
import { Skeleton } from '../components/shared/Skeleton';
import { SearchInput } from '../components/shared/SearchInput';
import { StatusBadge } from '../components/shared/StatusBadge';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { AbilityCompileConfigDrawer } from '../components/abilities/AbilityCompileConfigDrawer';
import {
  abilitiesApi,
  compileStatusLabel,
  compileStatusTone,
  estimateCompileTokens,
  DOMAIN_TAGS,
  type Ability,
  type AbilityPackage,
  type CompileConfigResponse,
  type CreateAbilityBody,
} from '../lib/abilities';
import { apiErrorMessage } from '../lib/api';

export function AbilitiesPage() {
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [abilities, setAbilities] = useState<Ability[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<string>('all');
  const [createPending, setCreatePending] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const [compileConfig, setCompileConfig] = useState<CompileConfigResponse | null>(null);
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);

  const refreshConfig = useCallback(async () => {
    try {
      const cfg = await abilitiesApi.getCompileConfig();
      setCompileConfig(cfg);
    } catch {
      // Best-effort — the page still works without the banner.
    }
  }, []);

  useEffect(() => { void refreshConfig(); }, [refreshConfig]);

  const createAbility = useCallback(async () => {
    setCreatePending(true);
    try {
      const { ability } = await abilitiesApi.create({
        name: 'Untitled ability',
        iconEmoji: '⚡',
        domainTag: 'custom',
        specs: {},
        rulesAlways: [],
        rulesNever: [],
        toolHints: [],
      });
      toast.success('Ability created', ability.name);
      nav(`/abilities/${ability.id}`);
    } catch (err) {
      toast.error('Could not create ability', apiErrorMessage(err));
    } finally {
      setCreatePending(false);
    }
  }, [nav, toast]);

  const handleCreate = useCallback(async () => {
    if (createPending) return;
    await createAbility();
  }, [createAbility, createPending]);

  // ABILITIES-10X — the 10x creation engine: describe an outcome in one line and
  // a finished, compiling specialist exists in seconds, at zero cost.
  const draftWithAI = useCallback(async () => {
    if (createPending) return;
    const intent = window.prompt(
      'Describe the specialist you want in one line.\n\nExample: "Draft SOC2-aware security review comments for pull requests"',
    );
    if (!intent || !intent.trim()) return;
    setCreatePending(true);
    try {
      const res = await abilitiesApi.draft({ from: 'intent', intent: intent.trim() });
      toast.success(
        res.synthesized ? 'Specialist drafted' : 'Starter draft created',
        res.notes[0] ?? res.ability.name,
      );
      nav(`/abilities/${res.ability.id}`);
    } catch (err) {
      toast.error('Could not draft ability', apiErrorMessage(err));
    } finally {
      setCreatePending(false);
    }
  }, [createPending, nav, toast]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await abilitiesApi.list();
      setAbilities(data.abilities);
    } catch (err) {
      toast.error('Could not load abilities', apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while any ability is compiling so the badge updates without a manual refresh.
  useEffect(() => {
    const anyCompiling = abilities.some((a) => a.compileStatus === 'compiling');
    if (!anyCompiling) return;
    const t = setInterval(() => { void refresh(); }, 4_000);
    return () => clearInterval(t);
  }, [abilities, refresh]);

  const existingDomains = useMemo(() => {
    const presentTags = new Set<string>();
    abilities.forEach((a) => {
      if (a.domainTag) {
        presentTags.add(a.domainTag);
      }
    });
    return DOMAIN_TAGS.filter((tag) => presentTags.has(tag.value));
  }, [abilities]);

  const filtered = useMemo(() => {
    let list = abilities;
    if (selectedDomain !== 'all') {
      list = list.filter((a) => a.domainTag === selectedDomain);
    }
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((a) =>
      a.name.toLowerCase().includes(q)
      || (a.description ?? '').toLowerCase().includes(q)
      || (a.domainTag ?? '').toLowerCase().includes(q),
    );
  }, [abilities, search, selectedDomain]);

  async function handleImportFile(file: File) {
    try {
      const text = await file.text();
      const pkg = JSON.parse(text) as AbilityPackage;
      const res = await abilitiesApi.import(pkg);
      toast.success('Ability imported', res.ability.name);
      await refresh();
    } catch (err) {
      toast.error('Import failed', apiErrorMessage(err));
    }
  }

  async function handleDelete(ability: Ability) {
    const ok = await confirm({
      title: `Delete ${ability.name}?`,
      body: 'Removes the ability, its examples, and its knowledge. Pinned agents lose access.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await abilitiesApi.delete(ability.id);
      toast.success('Ability deleted', ability.name);
      await refresh();
    } catch (err) {
      toast.error('Delete failed', apiErrorMessage(err));
    }
  }

  async function handleRecompile(ability: Ability) {
    try {
      await abilitiesApi.compile(ability.id);
      toast.success('Compile queued', ability.name);
      await refresh();
    } catch (err) {
      toast.error('Compile failed', apiErrorMessage(err));
    }
  }

  const cost = estimateCompileTokens();
  const modelLabel = compileConfig?.workspace?.model
    ?? compileConfig?.env?.model
    ?? null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Workspace"
        title="Abilities"
        subtitle="Workspace-level specialists every agent can use automatically."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={compileConfig && !compileConfig.hasModel ? 'danger' : 'secondary'}
              size="sm"
              iconLeft={compileConfig && !compileConfig.hasModel ? <AlertTriangle size={14} /> : <Cpu size={14} />}
              onClick={() => setConfigDrawerOpen(true)}
              title={
                compileConfig && !compileConfig.hasModel
                  ? `Template fallback active. Configure a model for LLM personas; estimated ${cost.min.toLocaleString()}-${cost.max.toLocaleString()} tokens per compile.`
                  : undefined
              }
            >
              {modelLabel ? `Model: ${modelLabel}` : 'Template mode'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Download size={14} />}
              onClick={() => importInputRef.current?.click()}
            >
              Import
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Sparkles size={14} />}
              onClick={draftWithAI}
              disabled={createPending}
            >
              Create with AI
            </Button>
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Plus size={14} />}
              onClick={handleCreate}
              loading={createPending}
              disabled={createPending}
            >
              New ability
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept=".ability,.json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                e.target.value = '';
              }}
            />
          </div>
        }
      />

      <div className="flex flex-1 flex-col gap-4 overflow-auto px-6 py-5">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by name, description, or domain"
        />

        {existingDomains.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 py-0.5">
            <button
              type="button"
              onClick={() => setSelectedDomain('all')}
              className={`rounded-full px-3 py-1 text-[11px] font-bold border transition-all ${
                selectedDomain === 'all'
                  ? 'bg-accent/15 border-accent/20 text-accent shadow-sm'
                  : 'border-line bg-surface text-text-muted hover:border-line-strong hover:text-text-primary'
              }`}
            >
              All
            </button>
            {existingDomains.map((tag) => (
              <button
                key={tag.value}
                type="button"
                onClick={() => setSelectedDomain(tag.value)}
                className={`rounded-full px-3 py-1 text-[11px] font-bold border transition-all ${
                  selectedDomain === tag.value
                    ? 'bg-accent/15 border-accent/20 text-accent shadow-sm'
                    : 'border-line bg-surface text-text-muted hover:border-line-strong hover:text-text-primary'
                }`}
              >
                {tag.label}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, idx) => (
              <Skeleton key={idx} className="h-16 rounded-card" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Zap size={36} />}
            title={search.trim() ? 'No matching abilities' : 'No abilities yet'}
            body={
              search.trim()
                ? 'Try a different search, or create the ability you need.'
                : 'Compiled behavioral specializations for any agent. Define specs, add knowledge, create examples — compile once and share workspace-wide.'
            }
            primaryAction={
              <Button
                variant="primary"
                iconLeft={<Plus size={14} />}
                onClick={handleCreate}
                loading={createPending}
                disabled={createPending}
              >
                Create your first ability
              </Button>
            }
            variant="page"
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((ability) => (
              <li key={ability.id}>
                <AbilityListItem
                  ability={ability}
                  onOpen={() => nav(`/abilities/${ability.id}`)}
                  onRecompile={() => handleRecompile(ability)}
                  onDelete={() => handleDelete(ability)}
                  onExport={async () => {
                    try {
                      const pkg = await abilitiesApi.export(ability.id);
                      downloadAbilityPackage(pkg, ability.slug);
                      toast.success('Ability exported', `${ability.name}.ability`);
                    } catch (err) {
                      toast.error('Export failed', apiErrorMessage(err));
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <AbilityCompileConfigDrawer
        open={configDrawerOpen}
        onClose={() => setConfigDrawerOpen(false)}
        onSaved={() => { void refreshConfig(); }}
      />

    </div>
  );
}

function AbilityListItem({
  ability,
  onOpen,
  onRecompile,
  onExport,
  onDelete,
}: {
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
      className="flex items-center gap-4 rounded-card border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-surface-2 text-lg">
        {ability.iconEmoji ?? '⚡'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-[14px] font-medium text-text-primary">{ability.name}</h3>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[12px] text-text-muted truncate">
          <span>{ability.description?.trim() || 'No description'}</span>
          {ability.domainTag && (
            <>
              <span>·</span>
              <span className="capitalize">{ability.domainTag.replace(/_/g, ' ')}</span>
            </>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-text-muted">
          <span>{ability.exampleCount} {ability.exampleCount === 1 ? 'example' : 'examples'}</span>
          <span>·</span>
          <span>{ability.knowledgeCount} {ability.knowledgeCount === 1 ? 'ref' : 'refs'}</span>
        </div>
      </div>
      <StatusBadge
        tone={badgeTone as 'accent' | 'warn' | 'danger' | 'muted'}
        label={compileStatusLabel(ability.compileStatus)}
        pulse={ability.compileStatus === 'compiling'}
      />
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <IconButton
          icon={<MoreHorizontal size={14} />}
          label="More actions"
          size="sm"
          onClick={() => setMenuOpen((v) => !v)}
        />
        {menuOpen && (
          <div
            className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
              onClick={() => { setMenuOpen(false); onRecompile(); }}
            >
              <RefreshCw size={12} /> Recompile
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
              onClick={() => { setMenuOpen(false); onExport(); }}
            >
              <Upload size={12} /> Export .ability
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-[12px] text-danger hover:bg-danger-soft"
              onClick={() => { setMenuOpen(false); onDelete(); }}
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Helpers removed

// ────────────────────────────────────────────────────────────
// Misc helpers
// ────────────────────────────────────────────────────────────

export function downloadAbilityPackage(pkg: AbilityPackage, slug: string) {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug || 'ability'}.ability`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// Re-export the placeholder if someone wants to surface stale warnings.
export const ABILITIES_PAGE_WARNING = AlertTriangle;
