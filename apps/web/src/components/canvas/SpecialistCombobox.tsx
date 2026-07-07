/**
 * SpecialistCombobox — replaces the old hardcoded 10-role `<select>`. Roles
 * are an OPEN vocabulary (packages/core/src/types/specialist.ts): any
 * non-empty string is a legal `agentRole`, resolved on-demand via the
 * workspace specialist system. This combobox fetches the live specialist
 * roster (`GET /v1/specialists` — platform + custom + generated + community),
 * lets the operator pick one, or type a role that doesn't exist yet and
 * author it on the spot (`POST /v1/specialists`) — mirroring how
 * `SpecialistDemandRouter` already auto-creates specialists at runtime, just
 * done explicitly from the canvas instead of implicitly at dispatch.
 *
 * Modeled on ExtensionCombobox's fetch-backed combobox + create-new pattern
 * for visual/behavioral consistency within the inspector.
 */

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Sparkles, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface SpecialistSummary {
  role: string;
  name: string;
  description: string;
  source: 'platform' | 'custom' | 'community' | 'generated';
  status: 'live' | 'offline' | 'draft';
  agentId: string | null;
  tools: string[];
  capabilityTags: string[];
  avatarGlyph: string;
  colorHex: string;
}

const STATUS_DOT: Record<SpecialistSummary['status'], string> = {
  live: 'bg-success',
  offline: 'bg-warn',
  draft: 'bg-text-muted',
};

const SOURCE_LABEL: Record<SpecialistSummary['source'], string> = {
  platform: 'platform',
  custom: 'custom',
  generated: 'generated',
  community: 'community',
};

export function SpecialistCombobox({
  value,
  onChange,
}: {
  value: string;
  onChange: (role: string) => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [specialists, setSpecialists] = useState<SpecialistSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ specialists: SpecialistSummary[] }>('/v1/specialists')
      .then((res) => { if (!cancelled) setSpecialists(res.specialists ?? []); })
      .catch(() => { if (!cancelled) setSpecialists([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(() => specialists.find((s) => s.role === value), [specialists, value]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return specialists;
    return specialists.filter((s) => s.role.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [query, specialists]);

  const exactMatch = useMemo(
    () => specialists.some((s) => s.role.toLowerCase() === query.trim().toLowerCase()),
    [specialists, query],
  );
  const canCreate = query.trim().length > 0 && !exactMatch;

  async function createSpecialist(role: string) {
    const trimmed = role.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const res = await api<{ specialist: SpecialistSummary; created: boolean }>('/v1/specialists', {
        method: 'POST',
        body: JSON.stringify({ role: trimmed }),
      });
      setSpecialists((prev) => {
        const withoutExisting = prev.filter((s) => s.role !== res.specialist.role);
        return [...withoutExisting, res.specialist];
      });
      onChange(res.specialist.role);
      setQuery('');
      if (res.created) toast.success(`Authored specialist "${res.specialist.name}"`);
    } catch (err) {
      toast.error('Could not author specialist', (err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canCreate) {
              e.preventDefault();
              void createSpecialist(query);
            }
          }}
          placeholder={loading ? 'Loading specialists…' : 'Search or type a new role…'}
          className="w-full rounded border border-line bg-surface-2 py-1 px-2 text-[12px]"
        />
      </div>

      {value && (
        <div className="flex items-center justify-between rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px]">
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-accent">
            {selected && <span className={clsx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[selected.status])} />}
            <span className="truncate">Selected: {selected?.name ?? value}</span>
          </span>
          <button type="button" onClick={() => onChange('')} className="shrink-0 text-text-muted hover:text-danger">×</button>
        </div>
      )}

      {matches.length > 0 && (
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {matches.map((s) => (
            <li key={s.role}>
              <button
                type="button"
                onClick={() => onChange(s.role)}
                className={clsx(
                  'flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left text-[11px]',
                  value === s.role
                    ? 'border-accent/60 bg-accent/10 text-accent'
                    : 'border-line bg-surface hover:border-accent/40',
                )}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className={clsx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[s.status])} title={s.status} />
                  <Sparkles size={10} className="shrink-0 text-accent" />
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 text-[10px] text-text-muted">({s.role})</span>
                </span>
                <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[9px] text-text-muted">
                  {SOURCE_LABEL[s.source]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && specialists.length === 0 && !query && (
        <p className="text-center text-[11px] text-text-muted">No specialists yet — type a role name to author one.</p>
      )}

      {canCreate && (
        <button
          type="button"
          onClick={() => void createSpecialist(query)}
          disabled={creating}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-accent/40 bg-accent/5 py-1 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-60"
        >
          <Wand2 size={11} />
          {creating ? 'Authoring…' : `Author "${query.trim()}" as a new specialist`}
        </button>
      )}
    </div>
  );
}
