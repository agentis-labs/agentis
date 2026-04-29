import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

interface Workflow {
  id: string;
  title: string;
  summary: string | null;
  updatedAt: string;
}

export function WorkflowsPage() {
  const [items, setItems] = useState<Workflow[]>([]);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    void api<{ workflows: Workflow[] }>('/v1/workflows').then((d) => setItems(d.workflows));
  }, []);

  async function create() {
    setCreating(true);
    try {
      const seed = {
        title: 'Untitled workflow',
        graph: {
          version: 1,
          nodes: [
            {
              id: 'trigger',
              type: 'trigger',
              title: 'Start',
              position: { x: 80, y: 200 },
              config: { kind: 'trigger', triggerType: 'manual' },
            },
            {
              id: 'echo',
              type: 'skill_task',
              title: 'Echo',
              position: { x: 360, y: 200 },
              config: {
                kind: 'skill_task',
                skillId: 'BIND_AT_RUNTIME',
                inputMapping: {},
                outputMapping: {},
              },
            },
          ],
          edges: [{ id: 'e1', source: 'trigger', target: 'echo' }],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      };
      const res = await api<{ workflow: { id: string } }>('/v1/workflows', {
        method: 'POST',
        body: JSON.stringify(seed),
      });
      nav(`/workflows/${res.workflow.id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-medium">Workflows</h1>
        <button
          onClick={create}
          disabled={creating}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-60"
        >
          {creating ? 'Creating…' : '+ New workflow'}
        </button>
      </div>
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line p-10 text-center text-sm text-text-muted">
          No workflows yet. Create one to begin.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((w) => (
            <li key={w.id}>
              <Link
                to={`/workflows/${w.id}`}
                className="block rounded-2xl border border-line bg-surface p-4 shadow-card transition hover:border-accent/40"
              >
                <div className="text-sm font-medium">{w.title}</div>
                <div className="mt-1 text-xs text-text-muted">
                  {w.summary ?? 'No description'}
                </div>
                <div className="mt-3 text-xs text-text-muted">
                  Updated {new Date(w.updatedAt).toLocaleString()}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
