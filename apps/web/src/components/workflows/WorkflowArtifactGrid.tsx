/**
 * WorkflowArtifactGrid — the artifact card grid for a run's Output tab
 * (WORKFLOW-10X-MASTERPLAN §6.3 OutputGallery, V1).
 *
 * Renders every artifact a run produced (via artifact_save / artifact_collect)
 * as a card with a type glyph, name, size, and actions. HTML artifacts expand
 * to a live sandboxed preview inline; others offer a download.
 */

import { useState } from 'react';
import { Code2, Database, FileText, Globe, Image as ImageIcon, Download, Eye } from 'lucide-react';

export interface RunArtifact {
  id: string;
  type: 'html' | 'image' | 'document' | 'code' | 'data';
  title: string;
  content: string;
  thumbnailUrl?: string | null;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
}

const TYPE_GLYPH: Record<RunArtifact['type'], React.ReactNode> = {
  html: <Globe size={15} />,
  image: <ImageIcon size={15} />,
  document: <FileText size={15} />,
  code: <Code2 size={15} />,
  data: <Database size={15} />,
};

const TYPE_MIME: Record<RunArtifact['type'], string> = {
  html: 'text/html',
  image: 'image/png',
  document: 'text/plain',
  code: 'text/plain',
  data: 'application/json',
};

function artifactName(a: RunArtifact): string {
  const name = a.metadata && typeof a.metadata.name === 'string' ? a.metadata.name : null;
  return name ?? a.title ?? 'artifact';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ArtifactCard({ artifact }: { artifact: RunArtifact }) {
  const [previewing, setPreviewing] = useState(false);
  const name = artifactName(artifact);
  const size = artifact.content?.length ?? 0;

  const download = () => {
    const blob = new Blob([artifact.content ?? ''], { type: TYPE_MIME[artifact.type] });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  return (
    <div className="rounded-input border border-line bg-surface-2">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="shrink-0 text-text-muted">{TYPE_GLYPH[artifact.type]}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-text-primary" title={name}>{name}</div>
          <div className="text-[11px] uppercase tracking-wide text-text-muted">
            {artifact.type} · {formatBytes(size)}
          </div>
        </div>
        {artifact.type === 'html' && (
          <button
            type="button"
            onClick={() => setPreviewing((p) => !p)}
            aria-pressed={previewing}
            className="inline-flex h-7 items-center gap-1 rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-surface"
          >
            <Eye size={12} /> {previewing ? 'Hide' : 'Preview'}
          </button>
        )}
        <button
          type="button"
          onClick={download}
          aria-label={`Download ${name}`}
          className="inline-flex h-7 items-center gap-1 rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-surface"
        >
          <Download size={12} /> Download
        </button>
      </div>
      {previewing && artifact.type === 'html' && (
        <div className="border-t border-line bg-white p-2">
          <iframe
            title={`Preview of ${name}`}
            sandbox="allow-scripts"
            srcDoc={artifact.content}
            className="h-[360px] w-full rounded border border-line bg-white"
          />
        </div>
      )}
      {artifact.type === 'image' && /^(https?:|data:)/.test(artifact.content ?? '') && (
        <div className="border-t border-line p-2">
          <img src={artifact.content} alt={name} className="max-h-64 w-full rounded object-contain" />
        </div>
      )}
    </div>
  );
}

export function WorkflowArtifactGrid({ artifacts }: { artifacts: RunArtifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <section role="region" aria-label="Run artifacts" className="mt-8">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Artifacts ({artifacts.length})
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {artifacts.map((a) => (
          <ArtifactCard key={a.id} artifact={a} />
        ))}
      </div>
    </section>
  );
}
