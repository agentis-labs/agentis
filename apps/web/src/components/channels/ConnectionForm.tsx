/**
 * ConnectionForm — pure form for creating a channel connection.
 *
 * Props-driven; the parent owns submit semantics + the agents list.
 */
import { useState } from 'react';

interface Agent {
  id: string;
  name: string;
}
interface Props {
  agents: Agent[];
  onSubmit: (input: {
    kind: 'telegram' | 'discord';
    name: string;
    agentId: string;
    token: string;
    defaultChatId?: string;
  }) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}

export function ConnectionForm({ agents, onSubmit, onCancel, busy, error }: Props) {
  const [kind, setKind] = useState<'telegram' | 'discord'>('telegram');
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [token, setToken] = useState('');
  const [defaultChatId, setDefaultChatId] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          kind,
          name,
          agentId,
          token,
          ...(defaultChatId ? { defaultChatId } : {}),
        });
      }}
      className="space-y-3 text-sm"
    >
      <label className="block">
        <span className="text-xs text-text-muted">Channel</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'telegram' | 'discord')}
          className="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2"
          aria-label="kind"
        >
          <option value="telegram">Telegram</option>
          <option value="discord">Discord (outbound only)</option>
        </select>
      </label>

      <label className="block">
        <span className="text-xs text-text-muted">Display name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          className="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2"
          aria-label="name"
        />
      </label>

      <label className="block">
        <span className="text-xs text-text-muted">Route into agent</span>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          required
          className="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2"
          aria-label="agentId"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-xs text-text-muted">Bot token (encrypted at rest)</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          minLength={8}
          className="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2 font-mono"
          aria-label="token"
        />
      </label>

      <label className="block">
        <span className="text-xs text-text-muted">Default chat id (for outbound replies)</span>
        <input
          value={defaultChatId}
          onChange={(e) => setDefaultChatId(e.target.value)}
          className="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2 font-mono"
          aria-label="defaultChatId"
          placeholder="optional"
        />
      </label>

      {error && <div className="text-xs text-danger">{error}</div>}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={busy || !agents.length}
          className="rounded-md bg-accent px-3 py-1.5 text-xs text-canvas disabled:opacity-50"
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line px-3 py-1.5 text-xs hover:text-text-primary"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
