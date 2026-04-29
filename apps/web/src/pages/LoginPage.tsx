import { useState } from 'react';
import { login } from '../lib/api';

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('operator');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await login(username, password);
      onSuccess();
    } catch (e) {
      setErr((e as { message?: string }).message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <form
        onSubmit={submit}
        className="w-[360px] rounded-2xl border border-line bg-surface p-6 shadow-card"
      >
        <div className="mb-5 flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent shadow-glow" />
          <h1 className="text-base font-medium">Agentis</h1>
        </div>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-text-muted">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
            autoFocus
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs text-text-muted">Password</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        {err && <div className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{err}</div>}
        <button
          disabled={busy}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-canvas transition hover:opacity-90 disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
