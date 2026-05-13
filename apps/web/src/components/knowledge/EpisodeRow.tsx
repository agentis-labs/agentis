import { SourceBadge, TrustBar } from './MemoryEntryRow';
import type { EpisodeRowData } from './types';

export function EpisodeRow({ episode }: { episode: EpisodeRowData }) {
  return (
    <article className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
        <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
          {episode.type.replace(/_/g, ' ')}
        </span>
        {episode.source && <SourceBadge source={episode.source} />}
        {episode.createdAt && <span className="ml-auto">{new Date(episode.createdAt).toLocaleDateString()}</span>}
      </div>
      <h3 className="mt-2 text-subheading text-text-primary">{episode.title ?? episode.summary}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">{episode.summary}</p>
      {episode.details && <p className="mt-2 text-[12px] leading-relaxed text-text-muted">{episode.details}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <TrustBar value={episode.trust ?? episode.confidence ?? 1} />
        {episode.runId && <span className="font-mono text-[10px] text-text-muted">run_{episode.runId.slice(-6)}</span>}
      </div>
    </article>
  );
}