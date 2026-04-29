/**
 * Agent detail — terminal pane (live session messages from the mirror)
 * + capability summary + cancel-task action.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';

interface Agent {
  id: string;
  name: string;
  adapterType: string;
  status: string;
  colorHex: string;
  capabilityTags: string[] | null;
  currentTaskId: string | null;
  lastHeartbeatAt: string | null;
}

interface Message {
  id: string;
  role: 'operator' | 'agent' | 'system';
  body: string;
  createdAt: string;
}

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    void api<{ agents: Agent[] }>('/v1/agents').then((r) => {
      const found = r.agents.find((a) => a.id === id);
      if (found) setAgent(found);
    });
    void api<{ messages: Message[] }>(`/v1/conversations/${id}`).then((r) => setMessages(r.messages));
  }, [id]);

  useRealtime(['conversation.message_appended', 'agent.status', 'agent.heartbeat'], (env) => {
    const payload = env.payload as { agentId?: string; message?: Message };
    if (payload.agentId === id && payload.message) {
      setMessages((m) => [...m, payload.message!]);
    }
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send() {
    if (!id || !draft.trim()) return;
    setSending(true);
    try {
      await api(`/v1/agents/${id}/terminal/send`, {
        method: 'POST',
        body: JSON.stringify({ body: draft }),
      });
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  if (!agent) return <div className="p-6 text-text-muted">Loading agent…</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <span className="inline-block h-3 w-3 rounded-full" style={{ background: agent.colorHex }} />
        <div>
          <div className="text-sm font-medium">{agent.name}</div>
          <div className="text-xs text-text-muted">
            {agent.adapterType} • {agent.status}
            {agent.lastHeartbeatAt ? ` • ❤ ${new Date(agent.lastHeartbeatAt).toLocaleTimeString()}` : ''}
          </div>
        </div>
        {agent.currentTaskId && (
          <button
            onClick={() => api(`/v1/agents/${agent.id}/cancel-task/${agent.currentTaskId}`, { method: 'POST' })}
            className="ml-auto rounded-md border border-danger/40 px-2 py-1 text-xs text-danger"
          >
            Cancel current task
          </button>
        )}
        <Link to="/agents" className="ml-auto text-xs text-text-muted hover:text-accent">
          ← All agents
        </Link>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs">
        {messages.length === 0 && <div className="text-text-muted">No messages yet.</div>}
        {messages.map((m) => (
          <div key={m.id} className="mb-2">
            <div className="text-text-muted">
              [{new Date(m.createdAt).toLocaleTimeString()}] {m.role}
            </div>
            <pre className="whitespace-pre-wrap text-text-primary">{m.body}</pre>
          </div>
        ))}
      </div>
      <div className="border-t border-line bg-surface p-3">
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Send a message to the agent…"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            className="flex-1 resize-none rounded-md border border-line bg-canvas px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
          />
          <button
            disabled={sending || !draft.trim()}
            onClick={send}
            className="self-end rounded-md bg-accent px-3 py-2 text-xs font-medium text-canvas disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send (⌘+Enter)'}
          </button>
        </div>
      </div>
    </div>
  );
}
