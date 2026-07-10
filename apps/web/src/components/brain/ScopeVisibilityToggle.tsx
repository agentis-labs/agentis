import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';


export function ScopeVisibilityToggle({ scopeId, compact = false }: { scopeId: string; compact?: boolean }) {
  const [surfaced, setSurfaced] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ surfacedInWorkspace: boolean }>(`/v1/brain/scopes/${encodeURIComponent(scopeId)}/visibility`)
      .then((r) => { if (alive) setSurfaced(r.surfacedInWorkspace); })
      .catch(() => { if (alive) setSurfaced(true); });
    return () => { alive = false; };
  }, [scopeId]);

  async function toggle() {
    if (surfaced === null || saving) return;
    const next = !surfaced;
    setSaving(true);
    try {
      await api(`/v1/brain/scopes/${encodeURIComponent(scopeId)}/visibility`, {
        method: 'PUT',
        body: JSON.stringify({ surfacedInWorkspace: next }),
      });
      setSurfaced(next);
    } catch { /* leave state unchanged */ } finally {
      setSaving(false);
    }
  }

  const shown = surfaced !== false;
  const title = shown
    ? 'This scope’s memory + knowledge appears in the Workspace Brain (labeled to its owner). Click to hide.'
    : 'Hidden from the Workspace Brain — lives only in this scope’s brain. Click to show.';

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={surfaced === null || saving}
        aria-label={shown ? 'In Workspace Brain' : 'Hidden from Workspace'}
        title={title}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-60 ${
          shown ? 'text-amber-300 hover:bg-surface-3' : 'text-text-muted hover:bg-surface-3 hover:text-text-primary'
        }`}
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : shown ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={surfaced === null || saving}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[11px] transition-colors ${
        shown ? 'border-amber-400/30 bg-amber-400/10 text-amber-300' : 'border-line bg-surface-2 text-text-muted hover:text-text-primary'
      } disabled:opacity-60`}
    >
      {saving ? <Loader2 size={12} className="animate-spin" /> : shown ? <Eye size={12} /> : <EyeOff size={12} />}
      {shown ? 'In Workspace Brain' : 'Hidden from Workspace'}
    </button>
  );
}


