import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';


export function ScopeVisibilityToggle({ scopeId }: { scopeId: string }) {
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
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={surfaced === null || saving}
      title={shown ? 'This scopeâ€™s memory + knowledge appears in the Workspace Brain (labeled to its owner). Click to hide.' : 'Hidden from the Workspace Brain â€” lives only in this scopeâ€™s brain. Click to show.'}
      className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[11px] transition-colors ${
        shown ? 'border-amber-400/30 bg-amber-400/10 text-amber-300' : 'border-line bg-surface-2 text-text-muted hover:text-text-primary'
      } disabled:opacity-60`}
    >
      {saving ? <Loader2 size={12} className="animate-spin" /> : shown ? <Eye size={12} /> : <EyeOff size={12} />}
      {shown ? 'In Workspace Brain' : 'Hidden from Workspace'}
    </button>
  );
}


