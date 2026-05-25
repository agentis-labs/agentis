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
import { DataTableViewer, CodeViewer, ImageViewer, PdfViewer, VideoPlayer, AudioPlayer, DiffViewer, CodebaseViewer, DashboardViewer, WebsitePreview, DeploymentCard, APIExplorer, dashboardSpecFrom, filesFrom, deploymentSpecFrom, openApiFrom, rowsFrom } from './OutputViewers';

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
        {canPreview(artifact) && (
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
      {previewing && (
        <div className="border-t border-line p-2">
          <ArtifactPreview artifact={artifact} name={name} />
        </div>
      )}
    </div>
  );
}

/** Whether an artifact has an inline viewer (drives the Preview toggle). */
function canPreview(a: RunArtifact): boolean {
  if (a.type === 'html' || a.type === 'code') return true;
  if (a.type === 'image') return /^(https?:|data:)/.test(a.content ?? '');
  if (a.type === 'document') return (a.content ?? '').startsWith('data:application/pdf');
  if (a.type === 'data') return true;
  return false;
}

/** Dispatch an artifact to its Layer 6 viewer. */
function ArtifactPreview({ artifact, name }: { artifact: RunArtifact; name: string }) {
  const content = artifact.content ?? '';
  if (artifact.type === 'html') {
    return <iframe title={`Preview of ${name}`} sandbox="allow-scripts" srcDoc={content} className="h-[360px] w-full rounded border border-line bg-white" />;
  }
  if (artifact.type === 'image') {
    return <ImageViewer src={content} alt={name} />;
  }
  if (artifact.type === 'document' && content.startsWith('data:application/pdf')) {
    return <PdfViewer src={content} name={name} />;
  }
  if (/^data:video\//.test(content) || /\.(mp4|webm|mov)(\?|$)/i.test(content)) {
    return <VideoPlayer src={content} name={name} />;
  }
  if (/^data:audio\//.test(content) || /\.(mp3|wav|ogg|m4a)(\?|$)/i.test(content)) {
    return <AudioPlayer src={content} name={name} />;
  }
  if (artifact.type === 'data') {
    try {
      const parsed = JSON.parse(content);
      const api = openApiFrom(parsed);
      if (api) return <APIExplorer spec={api} />;
      const deploy = deploymentSpecFrom(parsed);
      if (deploy) return <DeploymentCard spec={deploy} />;
      const files = filesFrom(parsed);
      if (files) return <CodebaseViewer files={files} />;
      const dash = dashboardSpecFrom(parsed);
      if (dash) return <DashboardViewer spec={dash} />;
      const rows = rowsFrom(parsed);
      if (rows) return <DataTableViewer rows={rows} />;
      return <CodeViewer code={JSON.stringify(parsed, null, 2)} language="json" />;
    } catch {
      return <CodeViewer code={content} language="text" />;
    }
  }
  if (artifact.type === 'code' && /^(diff --git |@@ |--- |\+\+\+ )/m.test(content)) {
    return <DiffViewer diff={content} />;
  }
  if (artifact.type === 'document' && /^https?:\/\/\S+$/.test(content.trim())) {
    return <WebsitePreview url={content.trim()} />;
  }
  return <CodeViewer code={content} language={artifact.type === 'code' ? 'code' : 'text'} />;
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
