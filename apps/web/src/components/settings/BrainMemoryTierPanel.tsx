/**
 * BrainMemoryTierPanel — Settings → Runtimes.
 *
 * How much intelligence the Brain may spend deciding what to remember.
 *
 * This is a TIER, not an on/off, because the bundled on-device model cannot
 * judge: measured on a multilingual labelled set it scores 48% on the
 * remember-vs-drop decision (worse than chance) because a retrieval embedder
 * encodes topic, not speech act. So the real choice is which way the system
 * fails — keep generously and prune later, or let a model prune precisely.
 * Sits beside the model-assist switch because both govern the same spend.
 */

import { useCallback, useEffect, useState } from 'react';
import { Brain, Cpu, Sparkles, CircleSlash } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';

type Tier = 'off' | 'on_device' | 'model_assisted';

const OPTIONS: Array<{ value: Tier; icon: typeof Cpu; title: string; blurb: string }> = [
  {
    value: 'on_device',
    icon: Cpu,
    title: 'On-device',
    blurb: 'Keeps generously and prunes later. Uncertain notes are saved at low confidence and shown on the canvas instead of being dropped. Free, offline, works in every language.',
  },
  {
    value: 'model_assisted',
    icon: Sparkles,
    title: 'Model-assisted',
    blurb: 'A judge reconciles each candidate against what you already know and resolves conflicting pairs. Sharper and tidier — spends tokens on every capture.',
  },
  {
    value: 'off',
    icon: CircleSlash,
    title: 'Off',
    blurb: 'Form no new memories. Existing ones stay readable.',
  },
];

export function BrainMemoryTierPanel() {
  const toast = useToast();
  const [tier, setTier] = useState<Tier | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ memoryFormation?: { tier: Tier } }>('/v1/orchestrator/models');
      setTier(data.memoryFormation?.tier ?? 'model_assisted');
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function select(next: Tier) {
    if (next === tier || saving) return;
    const previous = tier;
    setTier(next); // optimistic — the control is the state
    setSaving(true); setError(null);
    try {
      await api('/v1/orchestrator/models/memory-formation-tier', {
        method: 'PATCH',
        body: JSON.stringify({ tier: next }),
      });
      toast.success(`Memory formation set to ${OPTIONS.find((o) => o.value === next)?.title ?? next}`);
    } catch (e) {
      setTier(previous);
      setError(apiErrorMessage(e));
      toast.error('Could not update memory formation', apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const active = OPTIONS.find((o) => o.value === tier) ?? null;

  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <Brain size={18} className="mt-0.5 text-accent" />
        <div className="min-w-0 flex-1">
          <h3 className="text-heading text-text-primary">What the Brain remembers</h3>
          <p className="mt-1 text-[12px] text-text-secondary">
            Deciding whether a sentence is a standing rule, a one-off task, or noise is a judgement call.
            Choose how much your workspace spends making it — and which way it errs when it is unsure.
          </p>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {OPTIONS.map((option) => {
              const Icon = option.icon;
              const isActive = tier === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={isActive}
                  disabled={tier === null || saving}
                  onClick={() => void select(option.value)}
                  className={`flex h-10 items-center justify-center gap-1.5 rounded-input border text-[12px] transition disabled:opacity-60 ${
                    isActive
                      ? 'border-accent bg-accent-soft text-text-primary'
                      : 'border-line bg-surface-2 text-text-muted hover:text-text-primary'
                  }`}
                >
                  <Icon size={14} />
                  {option.title}
                </button>
              );
            })}
          </div>

          {active && (
            <p className="mt-2 text-[12px] text-text-muted">{active.blurb}</p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[12px] text-warn">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
