/**
 * AgentConfigPanel — Config tab content for AgentDetailPage.
 *
 * Two sections:
 *   1. Runtime — RuntimePicker in editing mode (adapter locked, config editable)
 *   2. Identity & budget — name, role, glyph, color, tags, budget, paused, reportsTo
 */

import { useState } from 'react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { RuntimePicker, configToRuntimeConfig, isV1AdapterType, runtimeConfigToAdapterConfig, runtimeModelFor } from './RuntimePicker';
import type { AdapterType, RuntimeConfig } from './RuntimePicker';
import type { CommandAgent } from './AgentCard';

interface HarnessTestResult {
  status: 'pass' | 'warn' | 'fail';
  checks: Array<{ level: 'info' | 'warn' | 'error'; message: string; detail?: string }>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function AgentConfigPanel({
  agent,
  allAgents,
  onSaved,
}: {
  agent: CommandAgent & { config?: Record<string, unknown> | null; reportsTo?: string | null };
  allAgents: Array<{ id: string; name: string }>;
  onSaved: () => void;
}) {
  const toast = useToast();
  const adapterType: AdapterType = isV1AdapterType(agent.adapterType) ? agent.adapterType : 'http';
  const storedConfig = (agent.config ?? {}) as Record<string, unknown>;

  // Runtime section state
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(() =>
    configToRuntimeConfig(adapterType, storedConfig),
  );
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [testingRuntime, setTestingRuntime] = useState(false);
  const [testResult, setTestResult] = useState<HarnessTestResult | null>(null);

  // Identity section state
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role ?? '');
  const [avatarGlyph, setAvatarGlyph] = useState(agent.avatarGlyph ?? '');
  const [colorHex, setColorHex] = useState(agent.colorHex ?? '#6366f1');
  const [tagsInput, setTagsInput] = useState((agent.capabilityTags ?? []).join(', '));
  const [budget, setBudget] = useState(agent.monthlyBudgetCents != null ? String(agent.monthlyBudgetCents / 100) : '');
  const [isPaused, setIsPaused] = useState(agent.isPaused ?? false);
  const [reportsTo, setReportsTo] = useState(agent.reportsTo ?? '');
  const [savingIdentity, setSavingIdentity] = useState(false);

  async function saveRuntime() {
    setSavingRuntime(true);
    try {
      const config = runtimeConfigToAdapterConfig(adapterType, runtimeConfig);
      await api(`/v1/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ config, runtimeModel: runtimeModelFor(adapterType, runtimeConfig) }) });
      toast.success('Runtime saved', 'Adapter config updated.');
      onSaved();
    } catch (err) {
      toast.error('Save failed', err instanceof Error ? err.message : 'Could not save runtime config.');
    } finally {
      setSavingRuntime(false);
    }
  }

  async function testRuntime() {
    setTestingRuntime(true);
    setTestResult(null);
    try {
      const result = await api<HarnessTestResult>(`/v1/agents/${agent.id}/test-harness`, { method: 'POST' });
      setTestResult(result);
      if (result.status === 'pass') toast.success('Connection verified');
      else if (result.status === 'warn') toast.success('Connected with caveats');
      else toast.error('Connection failed', result.checks.find((check) => check.level === 'error')?.message ?? 'Harness check failed.');
    } catch (err) {
      toast.error('Test failed', err instanceof Error ? err.message : 'Could not test harness.');
    } finally {
      setTestingRuntime(false);
    }
  }

  async function saveIdentity() {
    setSavingIdentity(true);
    try {
      const capabilityTags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const monthlyBudgetCents = budget ? Math.round(parseFloat(budget) * 100) : null;
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim() || undefined,
          role: role.trim() || undefined,
          avatarGlyph: avatarGlyph.trim() || undefined,
          colorHex: colorHex || undefined,
          capabilityTags,
          monthlyBudgetCents,
          isPaused,
          reportsTo: reportsTo || null,
        }),
      });
      toast.success('Identity saved');
      onSaved();
    } catch (err) {
      toast.error('Save failed', err instanceof Error ? err.message : 'Could not save identity.');
    } finally {
      setSavingIdentity(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* ── Runtime ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Runtime config</div>
            <div className="mt-0.5 text-xs text-text-muted">Adapter endpoint, credentials, and model settings.</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void testRuntime()}
              disabled={testingRuntime}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
            >
              {testingRuntime ? 'Testing...' : 'Test connection'}
            </button>
            <button
              onClick={() => void saveRuntime()}
              disabled={savingRuntime}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-canvas disabled:opacity-50"
            >
              {savingRuntime ? 'Saving...' : 'Save runtime'}
            </button>
          </div>
        </div>
        <RuntimePicker
          adapterType={adapterType}
          runtimeConfig={runtimeConfig}
          onAdapterChange={() => {}}
          onConfigChange={setRuntimeConfig}
          editing
        />
        {testResult && (
          <div className="mt-4 rounded-lg border border-line bg-surface-2 p-3 text-xs">
            <div className={testResult.status === 'fail' ? 'text-danger' : testResult.status === 'warn' ? 'text-accent' : 'text-text-primary'}>
              {testResult.status === 'pass' ? 'Connection verified' : testResult.status === 'warn' ? 'Connected with caveats' : 'Connection failed'}
            </div>
            <div className="mt-2 space-y-1 text-text-muted">
              {testResult.checks.map((check, index) => (
                <div key={`${check.message}-${index}`}>
                  <span className={check.level === 'error' ? 'text-danger' : 'text-text-primary'}>{check.message}</span>
                  {check.detail ? <span> - {check.detail}</span> : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Identity & budget ───────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Identity &amp; budget</div>
            <div className="mt-0.5 text-xs text-text-muted">Name, role, appearance, budget limits.</div>
          </div>
          <button
            onClick={() => void saveIdentity()}
            disabled={savingIdentity}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-canvas disabled:opacity-50"
          >
            {savingIdentity ? 'Saving…' : 'Save identity'}
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Role">
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Software Engineer" className={inputCls} />
          </Field>
          <Field label="Avatar glyph">
            <input value={avatarGlyph} onChange={(e) => setAvatarGlyph(e.target.value)} placeholder="◈" maxLength={8} className={inputCls} />
          </Field>
          <Field label="Color">
            <div className="flex items-center gap-2">
              <input type="color" value={colorHex} onChange={(e) => setColorHex(e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-line bg-canvas p-0.5" />
              <input value={colorHex} onChange={(e) => setColorHex(e.target.value)} className={`${inputCls} font-mono`} />
            </div>
          </Field>
          <Field label="Capability tags" hint="Comma-separated">
            <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="coding, review, research" className={inputCls} />
          </Field>
          <Field label="Monthly budget (USD)">
            <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="No limit" className={inputCls} />
          </Field>
          <Field label="Reports to">
            <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} className={inputCls}>
              <option value="">— None —</option>
              {allAgents
                .filter((a) => a.id !== agent.id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Standby mode">
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                role="switch"
                aria-checked={isPaused}
                onClick={() => setIsPaused((v) => !v)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${isPaused ? 'bg-accent' : 'bg-line'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${isPaused ? 'translate-x-4' : 'translate-x-0'}`}
                />
              </button>
              <span className="text-xs text-text-muted">{isPaused ? 'Agent is on standby' : 'Agent is active'}</span>
            </div>
          </Field>
        </div>
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</span>
        {hint && <span className="text-[10px] text-text-muted">({hint})</span>}
      </span>
      {children}
    </label>
  );
}

const inputCls = 'w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent';
