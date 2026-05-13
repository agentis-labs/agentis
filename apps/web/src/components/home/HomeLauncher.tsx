/**
 * HomeLauncher — Agentis command launcher (AGENTIS-UX-V2 §3).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, ChevronDown, Hash, Layers2, Megaphone, Send, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, workspace as wsStore } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { useChatPanelStore } from '../chat/ChatPanelStore';
import { useViewportAwareness } from '../../lib/viewportContext';
import { FALLBACK_PLACEHOLDER_PHRASES, workspacePlaceholderPhrases } from './placeholderPhrases';
import { computeSuggestions, type Suggestion } from './useContextualSuggestions';

interface AgentLite { id: string; name: string; colorHex?: string | null; status?: string; defaultSuggestion?: string | null }
interface TeamLite { id: string; name: string; slug?: string; iconGlyph?: string | null; colorHex?: string | null }
interface WorkflowLite { id: string; title: string }
interface ApprovalLite { id: string; title?: string; summary?: string; source?: string; agentId?: string | null; createdAt?: string }
interface RunLite { id: string; workflowId?: string; workflowName?: string; agentId?: string | null; status: string }
interface ArtifactLite { id: string; title: string; agentId?: string | null; workflowId?: string | null; createdAt: string }

type Recipient =
  | { kind: 'general'; id: 'general'; label: string }
  | { kind: 'agent'; id: string; label: string; colorHex?: string | null }
  | { kind: 'team'; id: string; label: string; slug?: string; iconGlyph?: string | null; colorHex?: string | null }
  | { kind: 'broadcast'; id: 'all' | string; label: string; teamId?: string };

const LAST_RECIPIENT_KEY = 'agentis.launcher.lastRecipient';

export function HomeLauncher() {
  const nav = useNavigate();
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [teams, setTeams] = useState<TeamLite[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowLite[]>([]);
  const [approvals, setApprovals] = useState<ApprovalLite[]>([]);
  const [runs, setRuns] = useState<RunLite[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactLite[]>([]);
  const [operatorName, setOperatorName] = useState('operator');
  const [recipient, setRecipient] = useState<Recipient>({ kind: 'general', id: 'general', label: 'General' });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [text, setText] = useState('');
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [typedChars, setTypedChars] = useState(0);
  const shortcutActive = useRef(false);
  const baseRecipient = useRef<Recipient>({ kind: 'general', id: 'general', label: 'General' });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const awareness = useViewportAwareness();
  const [awarenessDismissed, setAwarenessDismissed] = useState(false);
  const awarenessActive =
    !awarenessDismissed &&
    awareness.context.surface !== 'home' &&
    awareness.context.surface !== 'chat' &&
    awareness.context.surface !== 'unknown';

  async function refresh() {
    const [agentRes, teamRes, workflowRes, approvalRes, runRes, artifactRes, meRes] = await Promise.allSettled([
      api<{ agents: AgentLite[] }>('/v1/agents'),
      api<{ teams: TeamLite[] }>('/v1/teams'),
      api<{ workflows: WorkflowLite[] }>('/v1/workflows'),
      api<{ approvals: ApprovalLite[] }>('/v1/approvals?status=pending'),
      api<{ runs: RunLite[] }>('/v1/runs?limit=50'),
      api<{ artifacts: ArtifactLite[] }>('/v1/artifacts?limit=6'),
      api<{ user?: { username?: string; email?: string | null } }>('/v1/auth/me'),
    ]);
    if (agentRes.status === 'fulfilled') setAgents(agentRes.value.agents ?? []);
    if (teamRes.status === 'fulfilled') setTeams(teamRes.value.teams ?? []);
    if (workflowRes.status === 'fulfilled') setWorkflows(workflowRes.value.workflows ?? []);
    if (approvalRes.status === 'fulfilled') setApprovals(approvalRes.value.approvals ?? []);
    if (runRes.status === 'fulfilled') setRuns(runRes.value.runs ?? []);
    if (artifactRes.status === 'fulfilled') setArtifacts(artifactRes.value.artifacts ?? []);
    if (meRes.status === 'fulfilled') setOperatorName(meRes.value.user?.username ?? 'operator');
  }

  useEffect(() => {
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void refresh();
  }, []);

  useRealtime(
    [
      REALTIME_EVENTS.AGENT_WORK_STEP,
      REALTIME_EVENTS.RUN_COMPLETED,
      REALTIME_EVENTS.RUN_FAILED,
      REALTIME_EVENTS.APPROVAL_REQUESTED,
      REALTIME_EVENTS.APPROVAL_RESOLVED,
      REALTIME_EVENTS.ARTIFACT_CREATED,
    ],
    () => void refresh(),
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAST_RECIPIENT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Recipient;
        setRecipient(parsed);
        baseRecipient.current = parsed;
      }
    } catch {
      /* ignore */
    }
  }, []);

  const phrases = useMemo(() => {
    const workspacePhrases = workspacePlaceholderPhrases({ agents, teams, workflows }).slice(0, 3);
    return [...workspacePhrases, ...FALLBACK_PLACEHOLDER_PHRASES].slice(0, 6);
  }, [agents, teams, workflows]);
  const phrase = phrases[phraseIdx % Math.max(phrases.length, 1)] ?? FALLBACK_PLACEHOLDER_PHRASES[0] ?? 'Ask your fleet to build, research, or run something';
  const placeholder = text ? '' : phrase.slice(0, typedChars);

  useEffect(() => {
    setTypedChars(0);
    const typeId = window.setInterval(() => {
      setTypedChars((chars) => {
        if (chars >= phrase.length) {
          window.clearInterval(typeId);
          return chars;
        }
        return chars + 1;
      });
    }, 40);
    const nextId = window.setTimeout(() => setPhraseIdx((i) => i + 1), Math.max(3200, phrase.length * 40 + 2500));
    return () => {
      window.clearInterval(typeId);
      window.clearTimeout(nextId);
    };
  }, [phraseIdx, phrase]);

  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [pickerOpen]);

  useEffect(() => {
    function onPrefill(event: Event) {
      const detail = (event as CustomEvent<{ prompt?: string; recipient?: Recipient }>).detail;
      if (!detail?.prompt) return;
      setText(detail.prompt);
      if (detail.recipient) pickRecipient(detail.recipient);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
    window.addEventListener('agentis:launcher-prefill', onPrefill);
    return () => window.removeEventListener('agentis:launcher-prefill', onPrefill);
  }, []);

  const activeRuns = useMemo(
    () => runs.filter((run) => ['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'running', 'pending'].includes(run.status)),
    [runs],
  );

  const suggestions = useMemo(
    () => computeSuggestions({
      activeRuns,
      recentArtifacts: artifacts,
      pendingApprovals: approvals,
      agents,
      teams,
      workspaceAgeDays: 0,
      lastActivityAt: null,
    }),
    [activeRuns, agents, approvals, artifacts, teams],
  );

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const salutation = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    // §24.2 — adaptive line: "[N] runs active. [M] things need your attention."
    let line = 'Your fleet is ready.';
    const runCount = activeRuns.length;
    const pendingCount = approvals.length;
    if (runCount === 0 && pendingCount === 0) {
      if (artifacts.length > 0) {
        line = `${artifacts.length} thing${artifacts.length === 1 ? '' : 's'} built recently.`;
      } else {
        line = 'Your fleet is ready.';
      }
    } else if (pendingCount > 0 && runCount > 0) {
      line = `${runCount} run${runCount === 1 ? '' : 's'} active. ${pendingCount} thing${pendingCount === 1 ? '' : 's'} need your attention.`;
    } else if (pendingCount > 0) {
      line = `${pendingCount} thing${pendingCount === 1 ? '' : 's'} need your attention.`;
    } else if (runCount > 0) {
      line = `${runCount} run${runCount === 1 ? '' : 's'} active. Everything looks good.`;
    }
    return { salutation: `${salutation}, ${operatorName}.`, line };
  }, [activeRuns.length, approvals.length, artifacts.length, operatorName]);

  function pickRecipient(next: Recipient) {
    setRecipient(next);
    baseRecipient.current = next;
    shortcutActive.current = false;
    setPickerOpen(false);
    try { localStorage.setItem(LAST_RECIPIENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    inputRef.current?.focus();
  }

  function applyRouteShortcut(value: string) {
    if (/^\s*\/broadcast(?:\s|$)/i.test(value)) {
      setRecipient({ kind: 'broadcast', id: 'all', label: 'All agents' });
      shortcutActive.current = true;
      return;
    }

    const mention = value.match(/(?:^|\s)@([\w-]+)/);
    if (mention?.[1]) {
      const query = mention[1].toLowerCase();
      const agent = agents.find((item) => item.name.toLowerCase().replace(/\s+/g, '-') === query || item.name.toLowerCase().startsWith(query));
      if (agent) {
        setRecipient({ kind: 'agent', id: agent.id, label: agent.name, colorHex: agent.colorHex });
        shortcutActive.current = true;
        return;
      }
    }

    const tag = value.match(/(?:^|\s)#([\w-]+)/);
    if (tag?.[1]) {
      const query = tag[1].toLowerCase();
      const team = teams.find((item) => (item.slug ?? item.name).toLowerCase().replace(/\s+/g, '-') === query || item.name.toLowerCase().startsWith(query));
      if (team) {
        setRecipient({ kind: 'team', id: team.id, label: team.name, slug: team.slug, iconGlyph: team.iconGlyph, colorHex: team.colorHex });
        shortcutActive.current = true;
        return;
      }
    }

    if (shortcutActive.current) {
      setRecipient(baseRecipient.current);
      shortcutActive.current = false;
    }
  }

  function onTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setText(value);
    applyRouteShortcut(value);
  }

  function recipientFromSuggestion(suggestion: Suggestion): Recipient | null {
    if (!suggestion.recipient) return null;
    if (suggestion.recipient.kind === 'broadcast') return { kind: 'broadcast', id: 'all', label: 'All agents' };
    if (suggestion.recipient.kind === 'agent') {
      const agent = agents.find((item) => item.id === suggestion.recipient!.id);
      return agent ? { kind: 'agent', id: agent.id, label: agent.name, colorHex: agent.colorHex } : null;
    }
    if (suggestion.recipient.kind === 'team') {
      const team = teams.find((item) => item.id === suggestion.recipient!.id);
      return team ? { kind: 'team', id: team.id, label: team.name, slug: team.slug, iconGlyph: team.iconGlyph, colorHex: team.colorHex } : null;
    }
    return { kind: 'general', id: 'general', label: 'General' };
  }

  function send(message?: string, overrideRecipient?: Recipient | null) {
    const body = (message ?? text).trim();
    if (!body) return;
    const target = overrideRecipient ?? recipient;
    if (target.kind === 'agent') {
      // Send message to agent and surface it in the right-side chat panel
      void api(`/v1/conversations/${target.id}/send`, { method: 'POST', body: JSON.stringify({ body }) });
      const chatPanel = useChatPanelStore.getState();
      chatPanel.selectThread({ kind: 'agent', id: target.id, name: target.label });
      chatPanel.setState('docked');
    } else {
      // General / team / broadcast → full-screen chat page
      nav('/chat');
    }
    setText('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape' && !text.trim()) {
      setPickerOpen(false);
      setRecipient(baseRecipient.current);
    }
  }

  return (
    <div className="flex w-full items-center justify-center px-6 py-12 min-h-[clamp(420px,60vh,640px)]">
      <div className="w-full max-w-4xl">
        <div className="mb-5 text-center">
          <h1 className="text-xl font-medium text-text-primary">{greeting.salutation}</h1>
          <p className="mt-1 text-sm text-text-muted">{greeting.line}</p>
        </div>
        {awarenessActive && (
          <div className="mb-2 flex items-center justify-center gap-1 text-[11px] text-text-muted">
            <span className="max-w-full truncate rounded-full border border-line bg-canvas px-2 py-0.5">
              Viewing: {awareness.label}
            </span>
            <button
              type="button"
              onClick={() => setAwarenessDismissed(true)}
              aria-label="Dismiss viewport context"
              className="grid h-5 w-5 place-items-center rounded-md border border-line text-text-muted hover:text-text-primary"
            >
              ×
            </button>
          </div>
        )}
        <div className="overflow-visible rounded-xl border border-line bg-surface-1 shadow-lg focus-within:border-accent/60">
          <div className="flex items-center gap-2 border-b border-line/40 px-3 py-2">
            <div className="relative" ref={pickerRef}>
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text hover:border-accent/40"
              >
                <RecipientIcon r={recipient} />
                <span>{recipient.label}</span>
                <ChevronDown size={10} className="text-text-muted" />
              </button>
              {pickerOpen && (
                <div className="absolute left-0 top-full z-30 mt-1 max-h-[420px] w-80 overflow-y-auto rounded-lg border border-line bg-surface-1 shadow-2xl">
                  <PickerSection title="Rooms">
                    <PickerItem icon={<Hash size={12} />} label="General" detail="Workspace-wide" onClick={() => pickRecipient({ kind: 'general', id: 'general', label: 'General' })} />
                    {teams.slice(0, 8).map((team) => (
                      <PickerItem
                        key={team.id}
                        icon={<Hash size={12} style={{ color: team.colorHex ?? undefined }} />}
                        label={`${team.name} room`}
                        detail="Environment room"
                        onClick={() => pickRecipient({ kind: 'team', id: team.id, label: team.name, slug: team.slug, iconGlyph: team.iconGlyph, colorHex: team.colorHex })}
                      />
                    ))}
                  </PickerSection>
                  {agents.length > 0 && (
                    <PickerSection title="Direct to agent">
                      {agents.slice(0, 10).map((agent) => (
                        <PickerItem
                          key={agent.id}
                          icon={<Bot size={12} style={{ color: agent.colorHex ?? undefined }} />}
                          label={agent.name}
                          detail={agent.status}
                          onClick={() => pickRecipient({ kind: 'agent', id: agent.id, label: agent.name, colorHex: agent.colorHex })}
                        />
                      ))}
                    </PickerSection>
                  )}
                  <PickerSection title="Broadcast">
                    <PickerItem icon={<Megaphone size={12} />} label="All agents" onClick={() => pickRecipient({ kind: 'broadcast', id: 'all', label: 'All agents' })} />
                    {teams.slice(0, 8).map((team) => (
                      <PickerItem
                        key={`broadcast-${team.id}`}
                        icon={<Megaphone size={12} style={{ color: team.colorHex ?? undefined }} />}
                        label={`${team.name} environment`}
                        onClick={() => pickRecipient({ kind: 'broadcast', id: team.id, teamId: team.id, label: `${team.name} environment` })}
                      />
                    ))}
                  </PickerSection>
                </div>
              )}
            </div>
            <span className="text-[10px] uppercase tracking-wider text-text-muted">recipient</span>
          </div>
          <textarea
            ref={inputRef}
            value={text}
            onChange={onTextChange}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            rows={4}
            className="block w-full resize-none border-0 bg-transparent px-4 py-3 text-sm text-text placeholder:text-text-muted/70 focus:outline-none"
            aria-label="Message"
          />
          <div className="flex items-center justify-between border-t border-line/40 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
              <Sparkles size={10} className="text-accent" />
              <span>Enter to send · Shift+Enter newline</span>
            </div>
            <button
              type="button"
              onClick={() => send()}
              disabled={!text.trim()}
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition',
                text.trim()
                  ? 'bg-accent text-canvas hover:opacity-90'
                  : 'cursor-not-allowed bg-surface-2 text-text-muted',
              )}
            >
              <Send size={11} />
              Send
            </button>
          </div>
        </div>
        {suggestions.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => {
                  if (suggestion.href) nav(suggestion.href);
                  else send(suggestion.prompt, recipientFromSuggestion(suggestion));
                }}
                className="rounded-full border border-line bg-surface-1 px-3 py-1 text-[11px] text-text-muted transition hover:border-accent/50 hover:text-accent"
              >
                {suggestion.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecipientIcon({ r }: { r: Recipient }) {
  if (r.kind === 'agent') return <Bot size={11} style={{ color: r.colorHex ?? undefined }} />;
  if (r.kind === 'team') return <Layers2 size={11} style={{ color: r.colorHex ?? undefined }} />;
  if (r.kind === 'broadcast') return <Megaphone size={11} className="text-accent" />;
  return <Hash size={11} className="text-text-muted" />;
}

function PickerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="border-b border-line/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function PickerItem({ icon, label, detail, onClick }: { icon: React.ReactNode; label: string; detail?: string | null; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text hover:bg-surface-2"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="text-[10px] capitalize text-text-muted">{detail}</span>}
    </button>
  );
}
