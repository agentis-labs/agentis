/**
 * Composer — UIUX-REFACTOR §4.2.7.
 *
 * Power-user textarea with:
 *   - `/` slash command palette (run, pause, wake, approve, history,
 *     status, help). Hitting Enter in slash mode dispatches a
 *     `agentis:slash-command` window event so the rest of the app can
 *     react (e.g. open the workflow picker, navigate to /history).
 *   - `@` agent mention popover.
 *   - `#` resource reference popover (workflows, runs).
 *   - Keyboard shortcuts: ↑ to recall last sent, Shift+Enter newline,
 *     Enter to send.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ArrowUp } from 'lucide-react';
import { api } from '../../lib/api';

// Module-level draft cache — survives component unmount (panel close/reopen)
const _draftCache = new Map<string, string>();
export function clearDraft(key: string): void {
  _draftCache.delete(key);
}

interface Props {
  onSend: (text: string, options?: { useViewportContext?: boolean }) => Promise<void> | void;
  awareness?: {
    label: string;
    active: boolean;
  };
  initialText?: string;
  placeholder?: string;
  footer?: React.ReactNode;
  draftKey?: string;
}

interface Suggestion {
  id: string;
  label: string;
  detail?: string;
  /** Token to insert when accepted (without the trigger char) */
  insert: string;
}

interface SlashCommand {
  cmd: string;
  blurb: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: 'run', blurb: 'Run a workflow now (/run [workflow])' },
  { cmd: 'pause', blurb: 'Pause an agent (/pause @agent)' },
  { cmd: 'wake', blurb: 'Wake a paused agent (/wake @agent)' },
  { cmd: 'approve', blurb: 'Approve the most recent pending checkpoint' },
  { cmd: 'history', blurb: 'Open the unified history page' },
  { cmd: 'status', blurb: 'Show fleet status snapshot' },
  { cmd: 'help', blurb: 'List available commands' },
];

const TRIGGERS = ['/', '@', '#'] as const;
type Trigger = (typeof TRIGGERS)[number];

export function Composer({ onSend, awareness, initialText, placeholder, footer, draftKey }: Props) {
  const [text, setText] = useState<string>(() => {
    if (draftKey) {
      const cached = _draftCache.get(draftKey);
      if (cached !== undefined) return cached;
    }
    return initialText ?? '';
  });
  const [active, setActive] = useState<{ trigger: Trigger; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [useViewportContext, setUseViewportContext] = useState(true);
  const lastSent = useRef<string>('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  // Suggestion sources — agents for @, workflows/runs for #, slash for /.
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [workflows, setWorkflows] = useState<Array<{ id: string; title: string }>>([]);

  useEffect(() => {
    void api<{ agents: Array<{ id: string; name: string }> }>('/v1/agents')
      .then((r) => setAgents(r.agents))
      .catch(() => {});
    void api<{ workflows: Array<{ id: string; title: string }> }>('/v1/workflows')
      .then((r) => setWorkflows(r.workflows))
      .catch(() => {});
  }, []);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!active) return [];
    const q = active.query.toLowerCase();
    if (active.trigger === '/') {
      return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q)).map((c) => ({
        id: c.cmd,
        label: `/${c.cmd}`,
        detail: c.blurb,
        insert: c.cmd,
      }));
    }
    if (active.trigger === '@') {
      return agents
        .filter((a) => a.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((a) => ({ id: a.id, label: `@${a.name}`, insert: a.name.replace(/\s+/g, '_') }));
    }
    if (active.trigger === '#') {
      return workflows
        .filter((w) => w.title.toLowerCase().includes(q))
        .slice(0, 8)
        .map((w) => ({
          id: w.id,
          label: `#${w.title}`,
          detail: 'workflow',
          insert: w.title.replace(/\s+/g, '_'),
        }));
    }
    return [];
  }, [active, agents, workflows]);

  useEffect(() => {
    setHighlight(0);
  }, [active?.query]);

  useEffect(() => {
    setText(initialText ?? '');
    setActive(null);
    setHighlight(0);
  }, [initialText]);

  function detectTrigger(value: string, caret: number): { trigger: Trigger; query: string } | null {
    // Walk backwards from caret to find the nearest trigger char that is
    // either at start-of-line or preceded by whitespace.
    for (let i = caret - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === undefined) return null;
      if (ch === ' ' || ch === '\n') return null;
      if ((TRIGGERS as readonly string[]).includes(ch)) {
        const before = i === 0 ? '' : value[i - 1] ?? '';
        if (i === 0 || before === ' ' || before === '\n') {
          return { trigger: ch as Trigger, query: value.slice(i + 1, caret) };
        }
        return null;
      }
    }
    return null;
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setText(v);
    if (draftKey) _draftCache.set(draftKey, v);
    const caret = e.target.selectionStart ?? v.length;
    setActive(detectTrigger(v, caret));
    adjustHeight();
  }

  function acceptSuggestion(s: Suggestion) {
    if (!active || !taRef.current) return;
    const ta = taRef.current;
    const caret = ta.selectionStart ?? text.length;
    // Find the trigger position again so we replace just that token.
    const before = text.slice(0, caret);
    const tokenStart = before.lastIndexOf(active.trigger);
    if (tokenStart < 0) return;
    const next = `${text.slice(0, tokenStart + 1)}${s.insert} ${text.slice(caret)}`;
    setText(next);
    setActive(null);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = tokenStart + 1 + s.insert.length + 1;
      ta.setSelectionRange(pos, pos);
    });
  }

  async function dispatchSlash(cmd: string, raw: string) {
    window.dispatchEvent(
      new CustomEvent('agentis:slash-command', { detail: { cmd, raw } }),
    );
  }

  async function send() {
    const value = text.trim();
    if (!value) return;
    if (value.startsWith('/')) {
      const m = value.match(/^\/(\w+)\s*(.*)$/);
      if (m && m[1]) {
        await dispatchSlash(m[1].toLowerCase(), m[2] ?? '');
      }
    }
    lastSent.current = value;
    setText('');
    if (draftKey) _draftCache.delete(draftKey);
    await onSend(value, { useViewportContext });
    setUseViewportContext(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (active && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = suggestions[highlight];
        if (pick) acceptSuggestion(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setActive(null);
        return;
      }
    }
    if (e.key === 'ArrowUp' && !text && lastSent.current) {
      e.preventDefault();
      setText(lastSent.current);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="relative shrink-0 border-t border-line bg-surface px-3 py-2">
      {active && suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mx-3 mb-1 max-h-56 overflow-y-auto rounded-lg border border-line bg-surface shadow-card">
          <ul>
            {suggestions.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => acceptSuggestion(s)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm ${
                    i === highlight ? 'bg-surface-2 text-accent' : 'hover:bg-surface-2'
                  }`}
                >
                  <span>{s.label}</span>
                  {s.detail && <span className="truncate text-[10px] text-text-muted">{s.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {awareness?.active && useViewportContext && (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-text-muted">
          <span className="max-w-full truncate rounded-full border border-line bg-canvas px-2 py-0.5">
            Viewing: {awareness.label}
          </span>
          <button
            type="button"
            onClick={() => setUseViewportContext(false)}
            aria-label="Clear viewport context for next message"
            className="grid h-5 w-5 place-items-center rounded-md border border-line text-text-muted hover:text-text-primary"
          >
            ×
          </button>
        </div>
      )}
      <div className="relative">
        <textarea
          ref={taRef}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder ?? 'Message · / for commands · @ for agents · # for refs'}
          className="w-full resize-none rounded-xl border border-line bg-canvas pb-9 pl-3 pr-3 pt-3 text-sm text-text-primary outline-none transition-[border-color] focus:border-accent"
          style={{ minHeight: '44px', maxHeight: '200px', overflowY: 'auto' }}
        />
        <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-2 py-1.5">
          <div className="min-w-0 flex-1">{footer}</div>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim()}
            aria-label="Send message"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent text-canvas transition-opacity disabled:opacity-30"
          >
            <ArrowUp size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
