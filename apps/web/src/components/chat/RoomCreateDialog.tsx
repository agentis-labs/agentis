/**
 * RoomCreateDialog — modal for creating a new chat room with optional agent selection.
 *
 * Replaces the previous window.prompt() flow. Allows adding agents at
 * creation time so users don't have to chase down a separate "add member" step.
 */

import { useEffect, useRef, useState } from 'react';
import { X, Plus, Check } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface Agent { id: string; name: string; status?: string; }

interface RoomCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (room: { id: string; name: string }) => void;
}

export function RoomCreateDialog({ open, onClose, onCreated }: RoomCreateDialogProps) {
  const [name, setName] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setName('');
    setSelected(new Set());
    setPickerOpen(false);
    void api<{ agents: Agent[] }>('/v1/agents').then((d) => setAgents(d.agents ?? [])).catch(() => setAgents([]));
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const created = await api<{ room: { id: string; name: string } }>('/v1/rooms', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          kind: 'custom',
          agentIds: Array.from(selected),
        }),
      });
      toast.success('Room created', trimmed);
      onCreated(created.room);
    } catch (err) {
      toast.error('Failed to create room', String(err));
    } finally {
      setCreating(false);
    }
  }

  function toggleAgent(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const selectedAgents = agents.filter((a) => selected.has(a.id));

  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <form onSubmit={handleCreate} className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">Create a room</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        <div className="space-y-4 px-5 py-5">
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Name</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="e.g., Marketing standup"
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[12px] font-medium text-text-secondary">Add agents (optional)</label>
              <span className="text-[11px] text-text-muted">{selected.size} selected</span>
            </div>

            {selectedAgents.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedAgents.map((a) => (
                  <span
                    key={a.id}
                    className="inline-flex items-center gap-1 rounded-pill bg-accent-soft px-2.5 py-1 text-[12px] text-accent"
                  >
                    {a.name}
                    <button
                      type="button"
                      onClick={() => toggleAgent(a.id)}
                      aria-label={`Remove ${a.name}`}
                      className="rounded p-0.5 hover:bg-surface-3"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              >
                <Plus size={12} /> Add agent
              </button>
              {pickerOpen && (
                <div className="absolute z-10 mt-1.5 max-h-60 w-full overflow-y-auto rounded-card border border-line bg-surface shadow-dropdown">
                  {agents.length === 0 ? (
                    <div className="p-3 text-[12px] text-text-muted">No agents available.</div>
                  ) : (
                    agents.map((a) => {
                      const isSelected = selected.has(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => toggleAgent(a.id)}
                          className={clsx(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors',
                            isSelected ? 'bg-accent-soft text-accent' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                          )}
                        >
                          <span className={clsx('flex h-4 w-4 items-center justify-center rounded border', isSelected ? 'border-accent bg-accent' : 'border-line')}>
                            {isSelected && <Check size={10} className="text-canvas" />}
                          </span>
                          <span className="flex-1 truncate">{a.name}</span>
                          <span className="text-[10px] text-text-muted">{a.status ?? 'offline'}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || creating}
            className="inline-flex h-9 items-center justify-center rounded-btn bg-accent px-3 text-[13px] font-medium text-canvas transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </footer>
      </form>
    </div>
  );
}
