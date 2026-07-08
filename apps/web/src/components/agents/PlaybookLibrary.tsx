export interface PlaybookEntry {
  id: string;
  label: string;
  glyph: string;
  roles?: Array<'orchestrator' | 'manager' | 'worker'>;
  suggestedTags: string[];
  markdown: string;
}

export function PlaybookLibrary({ entries, onPick }: { entries: PlaybookEntry[]; onPick: (entry: PlaybookEntry) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onPick(entry)}
          className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-xs hover:border-accent/40 hover:text-accent"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded bg-canvas text-[11px]">{entry.glyph}</span>
          {entry.label}
        </button>
      ))}
    </div>
  );
}


