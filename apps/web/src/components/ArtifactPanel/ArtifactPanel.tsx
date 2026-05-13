/**
 * ArtifactPanel — modal/drawer surface for inspecting an artifact
 * (AGENTIS-UX-V2 §5.2).
 *
 * Supports closed | floating | docked | fullscreen states. Renderer chosen
 * by artifact.type. Sandboxed iframe for HTML; native img for image; pre
 * for code/data; plain prose for document.
 */
import { useEffect, useState } from 'react';
import { X, Maximize2, Minimize2, ExternalLink, Download, RefreshCw, Share2, Archive, PanelRightClose, PanelRightOpen } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import type { Artifact, PanelState } from './types';

interface Props {
  artifact: Artifact;
  state?: PanelState;
  onClose: () => void;
  onStateChange?: (state: PanelState) => void;
}

export function ArtifactPanel({ artifact, state: initial = 'docked', onClose, onStateChange }: Props) {
  const toast = useToast();
  const [state, setState] = useState<PanelState>(initial);

  // Sync external state changes (e.g. parent updating from `floating` → `docked`).
  useEffect(() => {
    setState(initial);
  }, [initial]);

  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  // §8.2 — when docked, compress the main zone via a body class so the Shell
  // grid can react. The CSS lives in index.css under `.has-docked-artifact`.
  useEffect(() => {
    const cls = 'has-docked-artifact-panel';
    if (state === 'docked') document.body.classList.add(cls);
    else document.body.classList.remove(cls);
    return () => document.body.classList.remove(cls);
  }, [state]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (state === 'closed') return null;

  function downloadArtifact() {
    const blob = new Blob([artifact.content], {
      type: artifact.type === 'html' ? 'text/html' : 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${artifact.title || artifact.id}.${extFor(artifact)}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function storeArtifact() {
    try {
      await api('/v1/memory', {
        method: 'POST',
        body: JSON.stringify({
          sourceType: 'artifact',
          sourceId: artifact.id,
          kind: 'artifact',
          title: artifact.title,
          content: artifact.content.slice(0, 32000),
          importance: 6,
          tags: ['artifact', artifact.type],
          metadata: { artifactId: artifact.id, artifactType: artifact.type },
        }),
      });
      toast.success('Stored in memory', artifact.title);
    } catch {
      toast.error('Could not store artifact');
    }
  }

  async function shareArtifact() {
    const url = `${window.location.origin}/artifacts?open=${encodeURIComponent(artifact.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Artifact link copied');
    } catch {
      toast.error('Could not copy link');
    }
  }

  function iterateArtifact() {
    window.dispatchEvent(new CustomEvent('agentis:room-general-message', {
      detail: { message: `Iterate on artifact "${artifact.title}" (${artifact.id}).` },
    }));
    toast.success('Iteration request sent to chat');
  }

  return (
    <div
      className={clsx(
        'fixed z-40 flex flex-col rounded-lg border border-line bg-surface-1 shadow-2xl',
        state === 'fullscreen' && 'inset-4',
        state === 'docked' && 'right-4 top-4 bottom-4 w-[640px] max-w-[calc(100vw-2rem)]',
        state === 'floating' && 'right-6 bottom-6 w-[480px] h-[360px]',
      )}
      role="dialog"
      aria-label={artifact.title}
    >
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-text">{artifact.title}</div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted">
            {artifact.type} · {new Date(artifact.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={iterateArtifact}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
            title="Iterate"
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            onClick={() => void storeArtifact()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
            title="Store in memory"
          >
            <Archive size={12} />
          </button>
          <button
            type="button"
            onClick={() => void shareArtifact()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
            title="Share"
          >
            <Share2 size={12} />
          </button>
          <button
            type="button"
            onClick={downloadArtifact}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
            title="Download"
          >
            <Download size={12} />
          </button>
          {/* §8.2 dock toggle — switches between floating (360px) and docked (480px, compresses main) */}
          {state !== 'fullscreen' && (
            <button
              type="button"
              onClick={() => setState(state === 'docked' ? 'floating' : 'docked')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
              title={state === 'docked' ? 'Float panel' : 'Dock panel (compress main)'}
              aria-pressed={state === 'docked'}
            >
              {state === 'docked' ? <PanelRightClose size={12} /> : <PanelRightOpen size={12} />}
            </button>
          )}
          {state !== 'fullscreen' ? (
            <button
              type="button"
              onClick={() => setState('fullscreen')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
              title="Maximize"
            >
              <Maximize2 size={12} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setState('docked')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
              title="Restore"
            >
              <Minimize2 size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-auto bg-surface-1">
        <ArtifactRenderer artifact={artifact} />
      </div>
    </div>
  );
}

function ArtifactRenderer({ artifact }: { artifact: Artifact }) {
  switch (artifact.type) {
    case 'html':
      return (
        <iframe
          title={artifact.title}
          srcDoc={artifact.content}
          sandbox="allow-scripts"
          className="h-full w-full border-0"
        />
      );
    case 'image':
      return (
        <div className="flex h-full items-center justify-center p-4">
          <img
            src={artifact.content}
            alt={artifact.title}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    case 'code':
      return (
        <pre className="m-0 h-full overflow-auto bg-canvas p-4 font-mono text-[12px] leading-relaxed text-text">
          <code>{artifact.content}</code>
        </pre>
      );
    case 'data':
      return <DataView content={artifact.content} />;
    case 'document':
    default:
      return (
        <div className="prose prose-invert max-w-none p-6 text-sm text-text">
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
            {artifact.content}
          </pre>
        </div>
      );
  }
}

function DataView({ content }: { content: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return (
      <pre className="m-0 h-full overflow-auto bg-canvas p-4 font-mono text-[12px] text-text">
        {content}
      </pre>
    );
  }
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0]) {
    const headers = Object.keys(parsed[0] as Record<string, unknown>);
    return (
      <div className="overflow-auto p-4">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-line">
              {headers.map((h) => (
                <th key={h} className="px-2 py-1.5 text-left font-medium text-text">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(parsed as Array<Record<string, unknown>>).map((row, i) => (
              <tr key={i} className="border-b border-line/40">
                {headers.map((h) => (
                  <td key={h} className="px-2 py-1.5 text-text-muted">
                    {formatCell(row[h])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <pre className="m-0 h-full overflow-auto bg-canvas p-4 font-mono text-[12px] text-text">
      {JSON.stringify(parsed, null, 2)}
    </pre>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function extFor(a: Artifact): string {
  switch (a.type) {
    case 'html': return 'html';
    case 'image': return 'png';
    case 'code': return 'txt';
    case 'data': return 'json';
    default: return 'txt';
  }
}

// Re-export so external imports stay terse.
export { ExternalLink };
