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
import { ArrowUp, Mic, MicOff, Paperclip, File, X, Eye, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { ComposerStatusBar } from './ComposerStatusBar';

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
      isFinal: boolean;
    };
  };
}

interface SpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (event: SpeechRecognitionEvent) => void;
  onend: () => void;
  onerror: (event: unknown) => void;
  start: () => void;
  stop: () => void;
}

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
  agentId?: string;
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

interface Attachment {
  id: string;
  name: string;
  type: string;
  url?: string;
  loading: boolean;
  progress: number;
}

export function Composer({ onSend, awareness, initialText, placeholder, footer, draftKey, agentId }: Props) {
  const [isFocused, setIsFocused] = useState(false);
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
  const [recording, setRecording] = useState(false);
  const lastSent = useRef<string>('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // File Attachment State
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback((files: FileList) => {
    const newAttachments: Attachment[] = Array.from(files).map((file) => {
      const id = `att-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const isImage = file.type.startsWith('image/');
      const url = isImage ? URL.createObjectURL(file) : undefined;

      // Simulate upload progress
      let progress = 0;
      const interval = window.setInterval(() => {
        setAttachments((prev) =>
          prev.map((att) => {
            if (att.id === id) {
              const nextProgress = att.progress + Math.floor(Math.random() * 20) + 15;
              if (nextProgress >= 100) {
                window.clearInterval(interval);
                return { ...att, progress: 100, loading: false };
              }
              return { ...att, progress: nextProgress };
            }
            return att;
          })
        );
      }, 120);

      return {
        id,
        name: file.name,
        type: file.type,
        url,
        loading: true,
        progress: 0,
      };
    });

    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, [handleFiles]);

  const speechSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const toggleRecording = useCallback(() => {
    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    if (!recognitionRef.current) {
      const SR =
        (window as any).SpeechRecognition ??
        (window as any).webkitSpeechRecognition;
      if (!SR) return;
      const recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const item = event.results[i];
          if (item && item[0]) {
            transcript += item[0].transcript;
          }
        }
        if (transcript) {
          setText((prev) => {
            const sep = prev && !prev.endsWith(' ') ? ' ' : '';
            return `${prev}${sep}${transcript}`;
          });
        }
      };
      recognition.onend = () => setRecording(false);
      recognitionRef.current = recognition;
    }
    recognitionRef.current?.start();
    setRecording(true);
  }, [recording]);

  const adjustHeight = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

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
    if (!value && attachments.length === 0) return;
    if (value.startsWith('/')) {
      const m = value.match(/^\/(\w+)\s*(.*)$/);
      if (m && m[1]) {
        await dispatchSlash(m[1].toLowerCase(), m[2] ?? '');
      }
    }
    lastSent.current = value;
    setText('');
    setAttachments([]);
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
    if (e.key === 'Escape' && !active) {
      e.preventDefault();
      taRef.current?.blur();
      return;
    }
    if (e.key === 'ArrowUp' && !text && lastSent.current) {
      e.preventDefault();
      setText(lastSent.current);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={clsx(
        "relative shrink-0 border-t border-line px-4 py-3 transition-all duration-300",
        "bg-glass-panel/95 backdrop-blur-md",
        isFocused ? "border-accent/30 shadow-[0_-4px_24px_rgba(74,222,128,0.04)]" : "shadow-card",
        dragOver && "border-accent/40 bg-accent/5 ring-1 ring-accent/20"
      )}
    >
      {active && suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mx-4 mb-2 max-h-60 overflow-y-auto rounded-xl border border-glass-border bg-glass-panel/98 backdrop-blur-xl shadow-modal z-50 animate-in fade-in slide-in-from-bottom-1 duration-150">
          <ul className="p-1.5 space-y-0.5">
            {suggestions.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => acceptSuggestion(s)}
                  className={clsx(
                    "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs rounded-lg transition-colors duration-150",
                    i === highlight
                      ? 'bg-accent/10 text-accent font-medium'
                      : 'text-text-secondary hover:bg-surface-3/50 hover:text-text-primary'
                  )}
                >
                  <span className="font-mono">{s.label}</span>
                  <div className="flex items-center gap-2">
                    {s.detail && <span className="truncate text-[10px] text-text-muted font-normal">{s.detail}</span>}
                    {i === highlight && (
                      <kbd className="hidden sm:inline-flex min-h-[16px] items-center justify-center rounded bg-surface px-1 font-mono text-[9px] text-text-muted">
                        Enter
                      </kbd>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {awareness?.active && useViewportContext && (
        <div className="mb-3 flex items-center gap-1.5 text-[11px] text-text-muted animate-in fade-in duration-200">
          <span className="inline-flex items-center gap-1.5 max-w-full truncate rounded-full border border-glass-border bg-glass-panel px-3 py-1 text-text-secondary shadow-sm font-medium">
            <Eye size={12} className="text-accent" />
            Viewing: <span className="text-text-primary font-semibold">{awareness.label}</span>
          </span>
          <button
            type="button"
            onClick={() => setUseViewportContext(false)}
            aria-label="Clear viewport context for next message"
            className="grid h-5 w-5 place-items-center rounded-full border border-line bg-surface-2 text-text-muted hover:text-danger hover:border-danger/30 transition-colors"
          >
            <X size={10} />
          </button>
        </div>
      )}
      
      {/* File Attachment Previews */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((att) => {
            const isImage = att.type.startsWith('image/');
            return (
              <div
                key={att.id}
                className="group relative flex items-center gap-2 rounded-lg border border-line bg-canvas/40 p-1.5 pr-2.5 text-xs text-text-secondary shadow-sm transition hover:border-accent/40"
              >
                {isImage && att.url ? (
                  <img
                    src={att.url}
                    alt={att.name}
                    className="h-8 w-8 rounded object-cover"
                  />
                ) : (
                  <div className="grid h-8 w-8 place-items-center rounded bg-surface text-text-muted">
                    <File size={14} />
                  </div>
                )}
                
                <div className="flex flex-col min-w-0 max-w-[120px]">
                  <span className="truncate font-medium text-[11px] text-text-primary">
                    {att.name}
                  </span>
                  {att.loading ? (
                    <div className="mt-1 h-1 w-16 overflow-hidden rounded bg-line">
                      <div
                        className="h-full bg-accent transition-all duration-300"
                        style={{ width: `${att.progress}%` }}
                      />
                    </div>
                  ) : (
                    <span className="text-[9px] text-text-muted">
                      {(att.type.split('/')[1] || 'file').toUpperCase()}
                    </span>
                  )}
                </div>
                
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                  aria-label="Remove file"
                  className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 place-items-center rounded-full bg-surface-3 text-text-muted shadow hover:text-danger hover:scale-105 group-hover:grid"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="relative group">
        <textarea
          ref={taRef}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          rows={1}
          placeholder={placeholder ?? 'Message · / commands · @ agents · # refs'}
          className={clsx(
            "w-full resize-none rounded-2xl border bg-canvas/60 pb-11 pl-4 pr-4 pt-3.5 text-sm text-text-primary outline-none transition-all duration-200",
            isFocused
              ? "border-accent/40 bg-canvas/80 shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)]"
              : "border-line bg-canvas/30 hover:border-line-strong"
          )}
          style={{ minHeight: '46px', maxHeight: '200px', overflowY: 'auto' }}
        />
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-2.5 py-2">
          <div className="min-w-0 flex-1 flex items-center gap-1">
            {footer}
            {agentId && <ComposerStatusBar agentId={agentId} />}
            {text.length > 500 && (
              <span className="text-[10px] text-text-muted font-mono bg-surface-3 px-1.5 py-0.5 rounded border border-line">
                {text.length.toLocaleString()}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,text/*"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files);
              }}
            />
            <button
              type="button"
              onClick={triggerFileSelect}
              aria-label="Attach files"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-text-muted hover:text-text-primary hover:bg-surface-3/60 transition-all duration-200"
            >
              <Paperclip size={14} />
            </button>
            {speechSupported && (
              <button
                type="button"
                onClick={toggleRecording}
                aria-label={recording ? 'Stop recording' : 'Start voice dictation'}
                className={clsx(
                  "relative grid h-8 w-8 shrink-0 place-items-center rounded-xl transition-all duration-200",
                  recording
                    ? "bg-danger/10 text-danger border border-danger/30"
                    : "text-text-muted hover:text-text-primary hover:bg-surface-3/60"
                )}
              >
                {recording && (
                  <span className="absolute inset-0 rounded-xl border border-danger animate-ping opacity-75" />
                )}
                {recording ? <MicOff size={14} /> : <Mic size={14} />}
              </button>
            )}
            <button
              type="button"
              onClick={() => void send()}
              disabled={(!text.trim() && attachments.length === 0) || attachments.some(a => a.loading)}
              aria-label="Send message"
              className={clsx(
                "grid h-8 w-8 shrink-0 place-items-center rounded-xl transition-all duration-200",
                (!text.trim() && attachments.length === 0) || attachments.some(a => a.loading)
                  ? "bg-surface-3 text-text-muted opacity-40 cursor-not-allowed"
                  : "bg-accent text-canvas hover:scale-105 active:scale-95 shadow-glow"
              )}
            >
              <ArrowUp size={14} className="font-bold" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
