import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

function normalize(color: string | null | undefined, fallback: string): string {
  return color && HEX_PATTERN.test(color) ? color : fallback;
}

/**
 * Lets the operator override a node's identity color (persisted as the
 * agent's `colorHex`). Sits under the runtime/model rail in the node detail
 * panel. `defaultColor` is what the node falls back to when no personal
 * color is set — shown as the picker's starting value.
 */
export function NodeColorPicker({
  agentId,
  colorHex,
  defaultColor,
  onUpdated,
}: {
  agentId: string;
  colorHex?: string | null;
  defaultColor: string;
  onUpdated?: (colorHex: string) => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState(normalize(colorHex, defaultColor));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(normalize(colorHex, defaultColor));
  }, [agentId, colorHex, defaultColor]);

  async function commit(next: string) {
    const nextHex = normalize(next, value);
    if (!HEX_PATTERN.test(nextHex) || nextHex.toLowerCase() === normalize(colorHex, defaultColor).toLowerCase()) {
      setValue(nextHex);
      return;
    }
    setValue(nextHex);
    setSaving(true);
    try {
      await api(`/v1/agents/${agentId}`, { method: 'PATCH', body: JSON.stringify({ colorHex: nextHex }) });
      onUpdated?.(nextHex);
    } catch (error) {
      setValue(normalize(colorHex, defaultColor));
      toast.error('Color update failed', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const isCustom = value.toLowerCase() !== defaultColor.toLowerCase();

  return (
    <section className="mb-3 border-b border-line/70 pb-3">
      <div className="flex items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Color</div>
        {saving && <Loader2 size={12} className="animate-spin text-text-muted" />}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <label
          className="relative h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-input border border-line"
          style={{ backgroundColor: value }}
          title="Pick a color"
        >
          <input
            type="color"
            value={value}
            onChange={(event) => void commit(event.target.value)}
            disabled={saving}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Pick a color"
          />
        </label>
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={(event) => void commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
          disabled={saving}
          spellCheck={false}
          maxLength={7}
          aria-label="Hex color"
          className="h-8 flex-1 rounded-input border border-line bg-surface-2 px-2.5 font-mono text-[12px] uppercase text-text-primary outline-none focus:border-accent disabled:opacity-50"
        />
        {isCustom && (
          <button
            type="button"
            onClick={() => void commit(defaultColor)}
            disabled={saving}
            className="shrink-0 rounded-btn border border-line bg-surface-2 px-2 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
          >
            Reset
          </button>
        )}
      </div>
    </section>
  );
}
