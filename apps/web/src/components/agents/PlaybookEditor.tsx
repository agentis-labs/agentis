import { useState } from 'react';
import { Check, Save } from 'lucide-react';

export function PlaybookEditor({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => Promise<void> | void;
}) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1200);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid min-h-[22rem] gap-3 lg:grid-cols-2">
      <div className="flex min-h-0 flex-col rounded-lg border border-line bg-canvas">
        <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs text-text-muted">
          <span>Playbook</span>
          {onSave && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 hover:text-accent disabled:opacity-50"
            >
              {saved ? <Check size={13} /> : <Save size={13} />}
              {saved ? 'Saved' : saving ? 'Saving' : 'Save'}
            </button>
          )}
        </div>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => { if (onSave) void save(); }}
          className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-sm leading-relaxed text-text-primary outline-none"
          placeholder="Write this agent's operating rules, scope, escalation rules, and style."
        />
      </div>
      <div className="min-h-0 overflow-auto rounded-lg border border-line bg-surface p-4 text-sm leading-relaxed">
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Preview</div>
        <Preview markdown={value} />
      </div>
    </div>
  );
}

function Preview({ markdown }: { markdown: string }) {
  if (!markdown.trim()) return <div className="text-text-muted">No playbook content yet.</div>;
  return (
    <div className="space-y-2">
      {markdown.split('\n').map((line, index) => {
        if (/^[A-Z][A-Z\s]+$/.test(line.trim())) {
          return <h3 key={index} className="pt-2 text-xs font-medium uppercase tracking-wider text-accent">{line}</h3>;
        }
        if (!line.trim()) return <div key={index} className="h-1" />;
        return <p key={index} className="whitespace-pre-wrap text-text-muted">{line}</p>;
      })}
    </div>
  );
}