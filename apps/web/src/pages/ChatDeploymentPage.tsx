import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Bot, Loader2, Send } from 'lucide-react';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

interface DeploymentConfig {
  deployment: {
    id: string;
    name: string;
    chatEnabled: boolean;
    publicAccess: boolean;
  };
}

function responseText(value: unknown): string {
  if (value === null || value === undefined) return 'Run started.';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = value as { response?: unknown; body?: unknown; text?: unknown; output?: unknown };
    const inner = record.response ?? record.body ?? record.text ?? record.output;
    if (typeof inner === 'string') return inner;
  }
  return JSON.stringify(value, null, 2);
}

export function ChatDeploymentPage() {
  const { deploymentId } = useParams();
  const [params] = useSearchParams();
  const apiKey = params.get('key');
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationId = useMemo(() => crypto.randomUUID(), []);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  useEffect(() => {
    if (!deploymentId) return;
    void (async () => {
      try {
        const res = await fetch(`/d/${deploymentId}`);
        if (!res.ok) throw new Error('Chat is unavailable');
        const data = (await res.json()) as DeploymentConfig;
        setConfig(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Chat is unavailable');
      }
    })();
  }, [deploymentId]);

  async function send() {
    const text = input.trim();
    if (!text || !deploymentId || sending) return;
    setInput('');
    setSending(true);
    setError(null);
    setMessages((list) => [...list, { role: 'user', text }]);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers['x-agentis-api-key'] = apiKey;
      const res = await fetch(`/d/${deploymentId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source: 'chat', message: text, conversationId, syncTimeoutMs: 5000 }),
      });
      const data = (await res.json()) as { response?: unknown; status?: string; runId?: string; error?: { message: string } };
      if (!res.ok) throw new Error(data.error?.message ?? 'Message failed');
      const reply = data.status === 'COMPLETED'
        ? responseText(data.response)
        : `Started run ${data.runId}. Current status: ${data.status}.`;
      setMessages((list) => [...list, { role: 'assistant', text: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Message failed');
      setMessages((list) => [...list, { role: 'system', text: 'Message failed.' }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen bg-canvas text-text-primary">
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-6">
        <header className="mb-4 flex items-center gap-3 border-b border-line pb-4">
          <div className="flex size-9 items-center justify-center rounded-lg border border-line bg-surface-2 text-accent">
            <Bot size={18} />
          </div>
          <div>
            <h1 className="text-base font-semibold">{config?.deployment.name ?? 'Agentis chat'}</h1>
            <p className="text-xs text-text-muted">Deployment chat</p>
          </div>
        </header>

        {error && <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

        <section className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg border border-line bg-surface/60 p-3">
          {messages.length === 0 && !error && (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">Start the conversation.</div>
          )}
          {messages.map((m, index) => (
            <div key={index} className={m.role === 'user' ? 'text-right' : 'text-left'}>
              <div className={m.role === 'user'
                ? 'inline-block max-w-[82%] rounded-lg bg-accent px-3 py-2 text-sm text-canvas'
                : m.role === 'system'
                  ? 'inline-block max-w-[82%] rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger'
                  : 'inline-block max-w-[82%] whitespace-pre-wrap rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text-primary'}>
                {m.text}
              </div>
            </div>
          ))}
          {sending && (
            <div className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text-muted">
              <Loader2 size={14} className="animate-spin" /> Running
            </div>
          )}
          <div ref={endRef} />
        </section>

        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none transition focus:border-accent/60"
            placeholder="Message"
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0 || !!error}
            className="inline-flex size-10 items-center justify-center rounded-lg bg-accent text-canvas transition hover:opacity-90 disabled:opacity-50"
            aria-label="Send message"
          >
            <Send size={16} />
          </button>
        </form>
      </main>
    </div>
  );
}
