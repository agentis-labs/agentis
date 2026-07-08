import { useState } from 'react';
import { login } from '../lib/api';
import { isPersistableLaunchToken, loginWithLaunchToken, setStoredLaunchToken } from '../lib/launchAuth';
import { BrandMark } from '../components/shared/BrandMark';

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('operator');
  const [credential, setCredential] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const value = credential.trim();
      if (value) {
        try {
          await loginWithLaunchToken(value);
          if (isPersistableLaunchToken(value)) setStoredLaunchToken(value);
          onSuccess();
          return;
        } catch {
        }
      }
      await login(username, credential);
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
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark variant="full" size={30} className="text-text-primary" />
          <p className="text-[12px] text-text-muted">Sign in to your command center</p>
        </div>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-text-muted">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs text-text-muted">Token or password</span>
          <input
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            type="password"
            autoFocus
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



