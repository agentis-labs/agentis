/**
 * NoteMarkdownPreview — Obsidian-style rendered view for Personal Brain notes.
 *
 * Markdown renders through the existing dependency-free ChatMarkdown engine;
 * this component adds the note-graph layer on top:
 *   • [[Wikilinks]] become navigable links (dashed when the target note
 *     doesn't exist yet — creating it is one click away, like Obsidian).
 *   • `extractWikilinks` / `findBacklinks` power the backlinks panel.
 */

import { Fragment, useMemo } from 'react';
import { ChatMarkdown } from '../chat/ChatMarkdown';

export interface NoteRef {
  id: string;
  title: string | null;
}

const WIKILINK_RE = /\[\[([^\][\n]{1,120}?)\]\]/g;

export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  for (const match of content.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

/** Notes whose content links to `title` via [[title]] (case-insensitive). */
export function findBacklinks(notes: Array<NoteRef & { content: string }>, title: string, selfId: string | null): NoteRef[] {
  const needle = title.trim().toLowerCase();
  if (!needle) return [];
  return notes
    .filter((note) => note.id !== selfId)
    .filter((note) => extractWikilinks(note.content).some((link) => link.toLowerCase() === needle));
}

export function NoteMarkdownPreview({ content, notes, onNavigate, onCreate }: {
  content: string;
  notes: NoteRef[];
  onNavigate: (noteId: string) => void;
  /** Create a note titled `title` and open it (dashed-link click). */
  onCreate?: (title: string) => void;
}) {
  // Split the document on wikilinks; render markdown segments between them so
  // links stay clickable React elements (never innerHTML).
  const segments = useMemo(() => {
    const out: Array<{ kind: 'md'; text: string } | { kind: 'link'; title: string }> = [];
    let last = 0;
    for (const match of content.matchAll(WIKILINK_RE)) {
      const index = match.index ?? 0;
      if (index > last) out.push({ kind: 'md', text: content.slice(last, index) });
      out.push({ kind: 'link', title: match[1]!.trim() });
      last = index + match[0].length;
    }
    if (last < content.length) out.push({ kind: 'md', text: content.slice(last) });
    return out;
  }, [content]);

  const byTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const note of notes) {
      if (note.title) map.set(note.title.trim().toLowerCase(), note.id);
    }
    return map;
  }, [notes]);

  if (!content.trim()) {
    return <p className="p-6 text-[13px] text-text-muted">Nothing to preview yet.</p>;
  }
  return (
    <div className="h-full overflow-y-auto p-6 text-[13.5px] leading-relaxed text-text-secondary">
      {segments.map((segment, index) => {
        if (segment.kind === 'md') {
          return <Fragment key={index}><ChatMarkdown text={segment.text} /></Fragment>;
        }
        const targetId = byTitle.get(segment.title.toLowerCase());
        return targetId ? (
          <button
            key={index}
            type="button"
            onClick={() => onNavigate(targetId)}
            className="mx-0.5 rounded px-1 text-accent underline decoration-accent/40 underline-offset-2 hover:bg-accent-soft"
          >
            {segment.title}
          </button>
        ) : (
          <button
            key={index}
            type="button"
            onClick={() => onCreate?.(segment.title)}
            title="Note does not exist yet — click to create"
            className="mx-0.5 rounded px-1 text-text-muted underline decoration-dashed underline-offset-2 hover:bg-surface-3 hover:text-text-primary"
          >
            {segment.title}
          </button>
        );
      })}
    </div>
  );
}
