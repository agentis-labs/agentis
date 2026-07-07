/**
 * ExtensionCombobox — ENGINE-10X §12.2. Local-first combobox that searches both
 * installed extensions and the AgentisHub registry. Registry results are debounced
 * 300ms and presented as ghost rows; clicking "Install & use" runs the
 * existing install pipeline and then selects the new extension.
 *
 * Installed extensions are grouped: Built-in extensions (echo / http_fetch) appear
 * first as always-available defaults, followed by user-installed extensions capped
 * at 5 rows with a "Show more" toggle. This keeps the list scannable even when
 * many extensions have been installed.
 */

import { useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, Cloud, Hammer, Search, Sparkles, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { ExtensionStudioModal } from '../extensions/ExtensionStudioModal';
import { isIdLike, shortRef } from '../../lib/prettyRef';
import { useAgentisStore, selectResourceName } from '../../store/agentisStore';

export interface InstalledExtensionOption {
  id: string;
  name: string;
  runtime?: string;
  operations?: Array<{ name: string }>;
}

interface RegistryEntry {
  slug: string;
  title: string;
  version?: string;
  verified?: boolean;
  installs?: number;
}

interface SuggestCandidate {
  slug: string;
  title: string;
  reasoning: string;
  installable: boolean;
}

const INSTALLED_SHOW_CAP = 5;

export function ExtensionCombobox({
  value,
  installed,
  onChange,
  onInstalledChange,
}: {
  value: string;
  installed: InstalledExtensionOption[];
  onChange: (extensionId: string) => void;
  /** Called after a successful install so the parent can refetch installed extensions. */
  onInstalledChange?: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [candidates, setCandidates] = useState<SuggestCandidate[]>([]);
  const [showAllInstalled, setShowAllInstalled] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { builtins, userInstalled } = useMemo(() => ({
    builtins: installed.filter((s) => s.runtime === 'builtin'),
    userInstalled: installed.filter((s) => s.runtime !== 'builtin'),
  }), [installed]);

  const { matchedBuiltins, matchedInstalled } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { matchedBuiltins: builtins, matchedInstalled: userInstalled };
    return {
      matchedBuiltins: builtins.filter((s) => s.name.toLowerCase().includes(q)),
      matchedInstalled: userInstalled.filter(
        (s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
      ),
    };
  }, [query, builtins, userInstalled]);

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) { setRegistry([]); return; }
    debounce.current = setTimeout(() => {
      void api<{ entries?: RegistryEntry[] }>(
        `/v1/extensions/registry?q=${encodeURIComponent(q.trim())}&pageSize=8`,
      )
        .then((res) => setRegistry(res.entries ?? []))
        .catch(() => setRegistry([]));
    }, 300);
  }

  async function installRegistry(entry: RegistryEntry) {
    const ok = await confirm({
      title: `Install "${entry.title}"?`,
      body: 'This grants the extension its declared permissions. Only install extensions you trust.',
      confirmLabel: 'Install',
      tone: 'warn',
    });
    if (!ok) return;
    try {
      await api(`/v1/extensions/registry/install/${entry.slug}`, {
        method: 'POST',
        body: JSON.stringify({ permissionsAcknowledged: true }),
      });
      toast.success(`Installed ${entry.title}`);
      onInstalledChange?.();
    } catch (err) {
      toast.error('Install failed', (err as Error).message);
    }
  }

  async function suggest() {
    if (!query.trim()) return;
    setSuggesting(true);
    try {
      const res = await api<{ candidates: SuggestCandidate[] }>('/v1/extensions/registry/suggest', {
        method: 'POST',
        body: JSON.stringify({ prompt: query.trim() }),
      });
      setCandidates(res.candidates);
    } catch (err) {
      toast.error('Suggestion failed', (err as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  const hasQuery = query.trim().length > 0;
  const visibleInstalled = showAllInstalled
    ? matchedInstalled
    : matchedInstalled.slice(0, INSTALLED_SHOW_CAP);
  const hiddenCount = matchedInstalled.length - INSTALLED_SHOW_CAP;
  const selectedMatch = installed.find((s) => s.id === value);
  // Fall back to the app-wide resource-name registry (populated when extensions
  // are fetched elsewhere) before giving up on resolving a real name.
  const registryName = useAgentisStore(selectResourceName('extension', value));
  // When the referenced extension can't be resolved at all, show a clean short
  // reference instead of leaking the raw UUID as if it were the extension's name.
  const selectedName = selectedMatch?.name
    ?? registryName
    ?? (isIdLike(value) ? `unresolved extension (${shortRef(value)})` : value);

  return (
    <div className="space-y-2">
      {/* Search input */}
      <div className="relative">
        <Search size={11} className="absolute left-2 top-2 text-text-muted" />
        <input
          value={query}
          onChange={handleQueryChange}
          placeholder="Search extensions or AgentisHub…"
          className="w-full rounded border border-line bg-surface-2 py-1 pl-6 pr-2 text-[12px]"
        />
      </div>

      {/* Build a new extension inline — no leaving the canvas. */}
      <button
        type="button"
        onClick={() => setStudioOpen(true)}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-accent/40 bg-accent/5 py-1 text-[11px] text-accent hover:bg-accent/10"
      >
        <Hammer size={11} /> Build new extension
      </button>

      {studioOpen && (
        <ExtensionStudioModal
          onClose={() => setStudioOpen(false)}
          onCreated={(ext) => {
            setStudioOpen(false);
            onInstalledChange?.();
            onChange(ext.id);
          }}
        />
      )}

      {/* Current selection pill */}
      {value && (
        <div className="flex items-center justify-between rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px]">
          <span className="truncate text-accent">Selected: {selectedName}</span>
          <button type="button" onClick={() => onChange('')} className="text-text-muted hover:text-danger">×</button>
        </div>
      )}

      {/* Built-in extensions — always shown unless filtered out */}
      {matchedBuiltins.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">Built-in</div>
          <ul className="space-y-1">
            {matchedBuiltins.map((s) => (
              <ExtensionOptionRow key={s.id} extension={s} selected={value === s.id} onClick={() => onChange(s.id)} />
            ))}
          </ul>
        </div>
      )}

      {/* User-installed extensions */}
      {matchedInstalled.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
            Installed ({matchedInstalled.length})
          </div>
          <ul className="space-y-1">
            {visibleInstalled.map((s) => (
              <ExtensionOptionRow key={s.id} extension={s} selected={value === s.id} onClick={() => onChange(s.id)} showRuntime />
            ))}
          </ul>
          {!showAllInstalled && hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllInstalled(true)}
              className="mt-1 flex w-full items-center justify-center gap-1 text-[10px] text-text-muted hover:text-text-primary"
            >
              <ChevronDown size={10} /> Show {hiddenCount} more
            </button>
          )}
        </div>
      )}

      {/* Empty state */}
      {!hasQuery && matchedBuiltins.length === 0 && matchedInstalled.length === 0 && (
        <p className="text-center text-[11px] text-text-muted">No extensions installed yet.</p>
      )}

      {/* Registry results from AgentisHub */}
      {registry.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
            From AgentisHub ({registry.length})
          </div>
          <ul className="space-y-1">
            {registry.map((entry) => (
              <li
                key={entry.slug}
                className="flex items-center justify-between rounded border border-dashed border-line bg-surface px-2 py-1 text-[11px]"
              >
                <span className="inline-flex items-center gap-1.5 truncate">
                  <Cloud size={10} className="text-text-muted" />
                  <span className="truncate">{entry.title}</span>
                  {entry.verified && (
                    <span className="rounded-full bg-accent/15 px-1.5 text-[9px] text-accent">verified</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void installRegistry(entry)}
                  className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/20"
                >
                  ⤓ Install & use
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Suggest button — only when there's a query */}
      {hasQuery && (
        <button
          type="button"
          onClick={() => void suggest()}
          disabled={suggesting}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-line bg-surface-2 py-1 text-[11px] text-text-primary hover:border-accent/40 disabled:opacity-60"
        >
          <Wand2 size={11} className="text-accent" />
          {suggesting ? 'Thinking…' : 'Suggest with agent'}
        </button>
      )}

      {/* Agent-suggested candidates */}
      {candidates.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">Agent suggestions</div>
          <ul className="space-y-1">
            {candidates.map((c) => (
              <li key={c.slug} className="rounded border border-line bg-surface px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-text-primary">{c.title}</span>
                  <button
                    type="button"
                    onClick={() => void installRegistry({ slug: c.slug, title: c.title })}
                    className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/20"
                  >
                    Use
                  </button>
                </div>
                <p className="mt-0.5 text-[10px] text-text-muted">{c.reasoning}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ExtensionOptionRow({
  extension,
  selected,
  onClick,
  showRuntime,
}: {
  extension: InstalledExtensionOption;
  selected: boolean;
  onClick: () => void;
  showRuntime?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={clsx(
          'flex w-full items-center justify-between rounded border px-2 py-1 text-left text-[11px]',
          selected
            ? 'border-accent/60 bg-accent/10 text-accent'
            : 'border-line bg-surface hover:border-accent/40',
        )}
      >
        <span className="inline-flex items-center gap-1.5">
          <Sparkles size={10} className="text-accent" />
          {extension.name}
        </span>
        <span className="text-[10px] text-text-muted">
          {extension.operations?.length ? `${extension.operations.length} ops` : (showRuntime ? extension.runtime : '')}
        </span>
      </button>
    </li>
  );
}
