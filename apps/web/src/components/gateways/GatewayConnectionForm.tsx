/**
 * GatewayConnectionForm — V1-SPEC §3.3, §11.8 pair-gateway form.
 */

import { useState } from 'react';

export interface GatewayConnectionFormProps {
  onSubmit: (args: { name: string; gatewayUrl: string; deviceToken: string }) => Promise<void>;
  busy?: boolean;
  error?: string | null;
}

export function GatewayConnectionForm({ onSubmit, busy, error }: GatewayConnectionFormProps) {
  const [name, setName] = useState('');
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [deviceToken, setDeviceToken] = useState('');
  const inputCls = 'w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm';
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({ name, gatewayUrl, deviceToken });
      }}
    >
      <Field label="Name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="Gateway URL">
        <input
          className={inputCls}
          value={gatewayUrl}
          onChange={(e) => setGatewayUrl(e.target.value)}
          placeholder="https://gateway.example.com"
          required
        />
      </Field>
      <Field label="Device token">
        <input
          className={`${inputCls} font-mono text-xs`}
          value={deviceToken}
          onChange={(e) => setDeviceToken(e.target.value)}
          required
        />
      </Field>
      {error && <div className="text-xs text-danger">{error}</div>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-canvas disabled:opacity-50"
      >
        {busy ? 'Pairing…' : 'Pair gateway'}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">{label}</span>
      {children}
    </label>
  );
}
