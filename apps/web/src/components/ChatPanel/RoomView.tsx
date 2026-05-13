import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';
import { ArtifactPanel } from '../ArtifactPanel/ArtifactPanel';
import type { Artifact } from '../ArtifactPanel/types';
import { CanvasEmbed } from './CanvasEmbed';
import { Composer } from './Composer';

interface RoomMessage {
  id: string;
  roomId: string;
  authorType: 'operator' | 'agent' | 'system';
  authorId: string | null;
  contentType: string;
  content: Record<string, unknown> | string | null;
  createdAt: string;
}

interface AgentRow {
  id: string;
  name: string;
  color?: string;
}

export function RoomView({ roomId, agents }: { roomId: string; agents: AgentRow[] }) {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    const data = await api<{ messages: RoomMessage[] }>(`/v1/rooms/${roomId}/messages?limit=200`);
    setMessages(data.messages ?? []);
  }

  useEffect(() => {
    void refresh();
  }, [roomId]);

  useRealtime(
    [REALTIME_EVENTS.ROOM_MESSAGE_SENT, REALTIME_EVENTS.ROOM_MESSAGE_RECEIVED],
    (env) => {
      const payload = env.payload as { roomId?: string; message?: RoomMessage };
      if (payload.roomId !== roomId && payload.message?.roomId !== roomId) return;
      if (payload.message) {
        setMessages((current) => current.some((item) => item.id === payload.message!.id) ? current : [...current, payload.message!]);
      } else {
        void refresh();
      }
    },
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  async function send(text: string) {
    if (!text.trim()) return;
    const optimistic: RoomMessage = {
      id: `tmp-${Date.now()}`,
      roomId,
      authorType: 'operator',
      authorId: null,
      contentType: 'text',
      content: { text },
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    try {
      const response = await api<{ message: RoomMessage }>(`/v1/rooms/${roomId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ contentType: 'text', content: { text } }),
      });
      setMessages((current) => current.map((item) => item.id === optimistic.id ? response.message : item));
    } catch {
      setMessages((current) => current.filter((item) => item.id !== optimistic.id));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-text-muted">
            No room messages yet.
          </div>
        )}
        {messages.map((message) => (
          <RoomBubble key={message.id} message={message} agents={agents} />
        ))}
      </div>
      <Composer onSend={send} />
    </div>
  );
}

function RoomBubble({ message, agents }: { message: RoomMessage; agents: AgentRow[] }) {
  const mine = message.authorType === 'operator';
  const author = agents.find((agent) => agent.id === message.authorId);
  const [openArtifact, setOpenArtifact] = useState<Artifact | null>(null);
  const content = normalizeContent(message.content);
  const text = String(content.text ?? content.body ?? content.summary ?? '');

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[86%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-accent/15 text-text-primary' : 'bg-surface-2 text-text-primary'}`}>
        {!mine && (
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-muted">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: author?.color ?? '#9cffb0' }} />
            {author?.name ?? message.authorType}
          </div>
        )}
        {message.contentType === 'artifact_card' && content.artifact && typeof content.artifact === 'object' ? (
          <button
            type="button"
            onClick={() => setOpenArtifact(content.artifact as Artifact)}
            className="w-full rounded-md border border-line bg-canvas px-3 py-2 text-left hover:border-accent/40"
          >
            <div className="text-xs font-medium text-text">{String((content.artifact as Artifact).title ?? 'Artifact')}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-text-muted">Open artifact</div>
          </button>
        ) : message.contentType === 'run_card' ? (
          <RunCard content={content} />
        ) : message.contentType === 'approval_card' ? (
          <ApprovalCard content={content} />
        ) : message.contentType === 'canvas_embed' && typeof content.runId === 'string' ? (
          <CanvasEmbed runId={content.runId} workflowId={typeof content.workflowId === 'string' ? content.workflowId : undefined} />
        ) : message.contentType === 'code' ? (
          <pre className="overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-[11px] text-text"><code>{text}</code></pre>
        ) : message.contentType === 'image' && typeof content.url === 'string' ? (
          <img src={content.url} alt="room attachment" className="max-h-[260px] rounded-md border border-line object-contain" />
        ) : message.contentType === 'data_table' && Array.isArray(content.rows) ? (
          <DataTable rows={content.rows as Array<Record<string, unknown>>} />
        ) : (
          <div className="whitespace-pre-wrap break-words">{text || JSON.stringify(content)}</div>
        )}
        <div className="mt-1 text-[10px] text-text-muted">{new Date(message.createdAt).toLocaleTimeString()}</div>
        {openArtifact && <ArtifactPanel artifact={openArtifact} state="docked" onClose={() => setOpenArtifact(null)} />}
      </div>
    </div>
  );
}

function RunCard({ content }: { content: Record<string, unknown> }) {
  const runId = typeof content.runId === 'string' ? content.runId : null;
  return (
    <div className="rounded-md border border-line bg-canvas p-3">
      <div className="text-xs font-medium text-text">{String(content.title ?? 'Workflow run')}</div>
      <div className="mt-1 text-[11px] text-text-muted">{String(content.status ?? 'Running')}</div>
      {runId && <Link to={`/runs/${runId}`} className="mt-2 inline-flex text-[10px] text-accent">View run</Link>}
    </div>
  );
}

function ApprovalCard({ content }: { content: Record<string, unknown> }) {
  const approvalId = typeof content.approvalId === 'string' ? content.approvalId : null;
  async function decide(decision: 'approve' | 'reject') {
    if (!approvalId) return;
    await api(`/v1/approvals/${approvalId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }).catch(() => undefined);
  }
  return (
    <div className="rounded-md border border-warn/40 bg-warn/10 p-3">
      <div className="text-xs font-medium text-text">{String(content.title ?? 'Approval needed')}</div>
      <div className="mt-1 text-[11px] text-text-muted">{String(content.summary ?? '')}</div>
      {approvalId && (
        <div className="mt-2 flex gap-2">
          <button onClick={() => void decide('approve')} className="rounded-md bg-accent px-2 py-1 text-[10px] text-canvas">Approve</button>
          <button onClick={() => void decide('reject')} className="rounded-md border border-line px-2 py-1 text-[10px] text-text-muted hover:text-danger">Reject</button>
        </div>
      )}
    </div>
  );
}

function DataTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const columns = Object.keys(rows[0] ?? {}).slice(0, 8);
  return (
    <div className="overflow-auto rounded-md border border-line">
      <table className="w-full text-[11px]">
        <thead className="bg-surface-2">
          <tr>{columns.map((column) => <th key={column} className="px-2 py-1 text-left font-medium text-text">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 25).map((row, index) => (
            <tr key={index} className="border-t border-line/40">
              {columns.map((column) => <td key={column} className="px-2 py-1 text-text-muted">{formatCell(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function normalizeContent(content: RoomMessage['content']): Record<string, unknown> {
  if (!content) return {};
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : { text: content };
    } catch {
      return { text: content };
    }
  }
  return content;
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}