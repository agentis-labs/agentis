/**
 * ConnectionRow — pure presentation row for a channel connection.
 *
 * Per V1-SPEC §3.3 web component discipline: props-driven, no fetching.
 */
interface Props {
  connection: {
    id: string;
    kind: string;
    name: string;
    agentId: string;
    status: string;
    defaultChatId: string | null;
    lastEventAt: string | null;
    lastError: string | null;
  };
  agentName?: string;
  onTest: (id: string) => void;
  onDelete: (id: string) => void;
  onShowWebhook: (id: string) => void;
}

const KIND_GLYPH: Record<string, string> = {
  telegram: '✈',
  discord: '◆',
};

export function ConnectionRow({ connection, agentName, onTest, onDelete, onShowWebhook }: Props) {
  const statusColor =
    connection.status === 'active'
      ? 'text-accent'
      : connection.status === 'error'
        ? 'text-danger'
        : 'text-text-muted';
  return (
    <div className="flex items-center gap-3 border-b border-line py-3 text-sm last:border-b-0">
      <span className="text-base text-text-muted" aria-hidden>
        {KIND_GLYPH[connection.kind] ?? '◌'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{connection.name}</div>
        <div className="font-mono text-[11px] text-text-muted">
          {connection.kind} · {agentName ?? connection.agentId.slice(0, 8)}
          {connection.defaultChatId && ` · chat ${connection.defaultChatId}`}
        </div>
        {connection.lastError && (
          <div className="mt-1 truncate text-[11px] text-danger" title={connection.lastError}>
            {connection.lastError}
          </div>
        )}
      </div>
      <span className={`text-[11px] ${statusColor}`}>{connection.status}</span>
      <button
        onClick={() => onShowWebhook(connection.id)}
        className="rounded-md border border-line px-2 py-0.5 text-[11px] hover:text-accent"
      >
        Webhook
      </button>
      <button
        onClick={() => onTest(connection.id)}
        className="rounded-md border border-line px-2 py-0.5 text-[11px] hover:text-accent"
      >
        Test
      </button>
      <button
        onClick={() => onDelete(connection.id)}
        className="rounded-md border border-line px-2 py-0.5 text-[11px] hover:text-danger"
      >
        Delete
      </button>
    </div>
  );
}
