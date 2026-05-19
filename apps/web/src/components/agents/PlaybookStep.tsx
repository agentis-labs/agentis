import { PlaybookEditor } from './PlaybookEditor';
import { PlaybookLibrary, type PlaybookEntry } from './PlaybookLibrary';

type AgentRole = 'orchestrator' | 'manager' | 'worker';

interface PlaybookStepProps {
  role: AgentRole;
  name: string;
  playbook: string;
  tags: string[];
  monthlyBudget: string;
  entries: PlaybookEntry[];
  onPlaybookChange: (value: string) => void;
  onTagsChange: (tags: string[]) => void;
  onMonthlyBudgetChange: (value: string) => void;
}

const inputCls =
  'mt-1 h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent';

function renderTemplate(markdown: string, name: string): string {
  return markdown.replaceAll('{{name}}', name || 'The Brain');
}

export function PlaybookStep({
  role: _role,
  name,
  playbook,
  tags,
  monthlyBudget,
  entries,
  onPlaybookChange,
  onTagsChange,
  onMonthlyBudgetChange,
}: PlaybookStepProps) {
  function pickTemplate(entry: PlaybookEntry) {
    onPlaybookChange(renderTemplate(entry.markdown, name));
    onTagsChange(entry.suggestedTags ?? []);
  }

  return (
    <div className="space-y-4">
      {entries.length > 0 && (
        <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
          <div className="text-xs font-medium uppercase tracking-wider text-text-muted">Start from a template</div>
          <PlaybookLibrary entries={entries} onPick={pickTemplate} />
        </div>
      )}

      <PlaybookEditor value={playbook} onChange={onPlaybookChange} />

      {!playbook.trim() && (
        <p className="text-[11px] text-text-muted">
          Without instructions, this agent will follow only what tasks assign it.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-text-secondary">Capability tags</span>
          <input
            value={tags.join(', ')}
            onChange={(event) =>
              onTagsChange(
                event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
            placeholder="research, coordination, review"
            className={inputCls}
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-text-secondary">Monthly budget</span>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-muted">$</span>
            <input
              value={monthlyBudget}
              onChange={(event) => onMonthlyBudgetChange(event.target.value)}
              inputMode="decimal"
              placeholder="500"
              className={`${inputCls} pl-6`}
            />
          </div>
          <span className="text-[11px] text-text-muted">per calendar month — leave blank for unlimited</span>
        </label>
      </div>
    </div>
  );
}
