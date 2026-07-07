/**
 * ArtifactPanel — modal/drawer surface for inspecting an artifact
 * (AGENTIS-UX-V2 §5.2).
 *
 * Supports closed | floating | docked | fullscreen states. Renderer chosen
 * by artifact.type. Sandboxed iframe for HTML; native img for image; pre
 * for code/data; plain prose for document.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Maximize2, Minimize2, ExternalLink, Download, RefreshCw, Share2, PanelRightClose, PanelRightOpen, Plus, Minus } from 'lucide-react';
import clsx from 'clsx';
import { api, apiBlob } from '../../lib/api';
import { useAssetUrl } from '../../lib/useAssetUrl';
import { useToast } from '../shared/Toast';
import { useChatPanelStore } from '../chat/ChatPanelStore';
import { safeResourceUrl } from '../workflows/OutputViewers';
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
    downloadArtifactFile(artifact);
  }

  // Branded native share — sends the actual asset file (so the recipient gets the
  // real screenshot/doc, not just a link) with a "made with Agentis" caption.
  // Desktop browsers without Web Share fall back to copying a branded link.
  async function shareArtifact() {
    const shareUrl = `${window.location.origin}/artifacts?open=${encodeURIComponent(artifact.id)}`;
    const caption = `${artifact.title} — made with Agentis ✨`;
    const nav = navigator as Navigator & {
      canShare?: (data?: ShareData) => boolean;
      share?: (data: ShareData) => Promise<void>;
    };
    try {
      const file = artifactToFile(artifact);
      if (file && nav.canShare?.({ files: [file] })) {
        await nav.share!({ files: [file], title: artifact.title, text: caption });
        return;
      }
      if (nav.share) {
        await nav.share({ title: artifact.title, text: caption, url: shareUrl });
        return;
      }
    } catch (err) {
      // User-cancelled share is an AbortError — stay silent.
      if ((err as Error)?.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(`${caption}\n${shareUrl}`);
      toast.success('Share link copied');
    } catch {
      toast.error('Could not share');
    }
  }

  // Open chat with a semi-ready, type-aware prompt the user can refine before
  // sending (the agent can pull the asset via agentis.assets.read using its ref).
  function iterateArtifact() {
    useChatPanelStore.getState().openChat({
      state: 'docked',
      launchContext: { initialDraft: buildIterateDraft(artifact), autoSendInitialDraft: false },
      returnPath: `${window.location.pathname}${window.location.search}`,
    });
    onClose();
  }

  const panel = (
    <div
      className={clsx(
        'fixed flex flex-col rounded-lg border border-line bg-surface shadow-2xl',
        // §8.2 — fullscreen sits above the Shell chrome (top bar/sidebar) on its
        // own backdrop; docked/floating stay below modals.
        state === 'fullscreen' && 'inset-4 z-[81]',
        state === 'docked' && 'right-4 top-4 bottom-4 z-40 w-[640px] max-w-[calc(100vw-2rem)]',
        state === 'floating' && 'right-6 bottom-6 z-40 w-[480px] h-[360px]',
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
      <div className="flex-1 overflow-auto bg-surface">
        <ArtifactRenderer artifact={artifact} />
      </div>
    </div>
  );

  // Render through a portal so the panel escapes any transformed/stacked parent
  // (the Shell grid, canvas, app surfaces). Fullscreen gets an opaque backdrop so
  // the page behind never bleeds through (the prior "transparent on maximize" bug).
  return createPortal(
    <>
      {state === 'fullscreen' && (
        <div className="fixed inset-0 z-[80] bg-canvas/90 backdrop-blur-sm" onClick={onClose} aria-hidden />
      )}
      {panel}
    </>,
    document.body,
  );
}

function ArtifactRenderer({ artifact }: { artifact: Artifact }) {
  switch (artifact.type) {
    case 'html':
      return (
        <iframe
          title={artifact.title}
          srcDoc={artifact.content}
          sandbox=""
          className="h-full w-full border-0"
        />
      );
    case 'image':
    case 'pdf':
    case 'audio':
    case 'video':
      return <MediaRenderer artifact={artifact} kind={artifact.type} />;
    case 'code':
      return (
        <pre className="m-0 h-full overflow-auto bg-canvas p-4 font-mono text-[12px] leading-relaxed text-text">
          <code>{artifact.content}</code>
        </pre>
      );
    case 'data':
      return <DataView content={artifact.content} />;
    case 'spreadsheet':
      // Inline CSV/TSV text renders as a table; binary sheets (xlsx) download.
      if (artifact.content.startsWith('data:')) {
        return <DownloadFallback artifact={artifact} note="Spreadsheet file — download to open." />;
      }
      return <DataView content={artifact.content} />;
    case 'archive':
      return <DownloadFallback artifact={artifact} note="Archive — download to extract its contents." />;
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

const DATA_URL_PREFIX: Record<'image' | 'pdf' | 'audio' | 'video', string[]> = {
  image: ['data:image/'],
  pdf: ['data:application/pdf'],
  audio: ['data:audio/'],
  video: ['data:video/'],
};

/**
 * Render binary media from either an inline `data:` URL (legacy) or a
 * content-addressed `asset://` reference (fetched as an authed object URL).
 */
function MediaRenderer({ artifact, kind }: { artifact: Artifact; kind: 'image' | 'pdf' | 'audio' | 'video' }) {
  const isData = (artifact.content ?? '').startsWith('data:');
  // Fetch only for non-inline (asset://) content; inline data: is used directly.
  const { url, loading, error } = useAssetUrl(isData ? null : artifact);
  const src = isData ? safeResourceUrl(artifact.content, DATA_URL_PREFIX[kind]) : url;

  if (!isData && loading) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-text-muted">Loading…</div>;
  }
  if (!src || (!isData && error)) {
    return <DownloadFallback artifact={artifact} note="Preview unavailable for this source." />;
  }
  switch (kind) {
    case 'image':
      return <ZoomableImage src={src} alt={artifact.title} />;
    case 'pdf':
      return <iframe title={artifact.title} src={src} className="h-full w-full border-0" />;
    case 'audio':
      return (
        <div className="flex h-full items-center justify-center p-6">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio src={src} controls className="w-full max-w-xl" />
        </div>
      );
    case 'video':
      return (
        <div className="flex h-full items-center justify-center p-4">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={src} controls className="max-h-full max-w-full" />
        </div>
      );
  }
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

/**
 * Pan + zoom image viewer. Scroll to zoom toward the cursor, drag to pan when
 * zoomed in, double-click to toggle. A bottom-left toolbar mirrors the Brain
 * canvas controls (+/−/fit). Zooming reveals the screenshot's native pixels, so a
 * page that's unreadable when fit-to-window becomes legible.
 */
function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Zoom around a focal point (relative to the container center) so the pixel
  // under the cursor stays put.
  const zoomTo = useCallback((nextScaleRaw: number, focal?: { x: number; y: number }) => {
    setScale((prev) => {
      const next = Math.min(Math.max(nextScaleRaw, MIN_ZOOM), MAX_ZOOM);
      if (next === prev) return prev;
      const ratio = next / prev;
      const fx = focal?.x ?? 0;
      const fy = focal?.y ?? 0;
      setOffset((o) =>
        next === MIN_ZOOM
          ? { x: 0, y: 0 }
          : { x: fx - ratio * (fx - o.x), y: fy - ratio * (fy - o.y) },
      );
      return next;
    });
  }, []);

  // Native non-passive wheel listener so we can preventDefault the page scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const focal = { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
      setScale((prev) => {
        const next = Math.min(Math.max(prev * (e.deltaY < 0 ? 1.15 : 1 / 1.15), MIN_ZOOM), MAX_ZOOM);
        if (next === prev) return prev;
        const ratio = next / prev;
        setOffset((o) =>
          next === MIN_ZOOM ? { x: 0, y: 0 } : { x: focal.x - ratio * (focal.x - o.x), y: focal.y - ratio * (focal.y - o.y) },
        );
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (scale <= MIN_ZOOM) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setOffset({ x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) });
  }
  function onPointerUp() {
    drag.current = null;
  }

  const zoomed = scale > MIN_ZOOM;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full select-none overflow-hidden bg-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onDoubleClick={(e) => {
        if (zoomed) return reset();
        const rect = containerRef.current?.getBoundingClientRect();
        const focal = rect ? { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 } : undefined;
        zoomTo(2.5, focal);
      }}
      style={{ cursor: zoomed ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in' }}
    >
      <div className="flex h-full w-full items-center justify-center p-4">
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full object-contain"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transition: drag.current ? 'none' : 'transform 80ms ease-out' }}
        />
      </div>

      <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1">
        <ZoomButton label="Zoom in" onClick={() => zoomTo(scale * 1.35)}><Plus size={14} /></ZoomButton>
        <ZoomButton label="Zoom out" onClick={() => zoomTo(scale / 1.35)}><Minus size={14} /></ZoomButton>
        <ZoomButton label="Reset zoom" onClick={reset}><Maximize2 size={13} /></ZoomButton>
      </div>

      {zoomed && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 rounded-md border border-line bg-surface-2/90 px-2 py-1 text-[10px] tabular-nums text-text-muted backdrop-blur">
          {Math.round(scale * 100)}%
        </div>
      )}
    </div>
  );
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-btn border border-line bg-surface-2/90 text-text-secondary shadow-card backdrop-blur transition-colors hover:bg-surface hover:text-text-primary"
    >
      {children}
    </button>
  );
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

/** Centered icon + download CTA for binary/unpreviewable assets (archives, xlsx, …). */
function DownloadFallback({ artifact, note }: { artifact: Artifact; note: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface-2 text-text-muted">
        <Download size={20} />
      </div>
      <div className="text-[12px] text-text-muted">{note}</div>
      <button
        type="button"
        onClick={() => downloadArtifactFile(artifact)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-canvas hover:bg-accent-hover"
      >
        <Download size={13} />
        Download {artifact.title || 'file'}
      </button>
    </div>
  );
}

/** Decode a `data:<mime>;base64,<…>` (or plain) URL into a typed Blob. Returns the
 * Blob — never the raw data URL — so downloads/shares produce valid, openable files
 * (Chrome truncates large `data:` hrefs, which yielded corrupt downloads). */
function dataUrlToBlob(dataUrl: string): { blob: Blob; mime: string } | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const payload = m[3] ?? '';
  if (m[2]) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return { blob: new Blob([bytes], { type: mime }), mime };
  }
  return { blob: new Blob([decodeURIComponent(payload)], { type: mime }), mime };
}

/** Materialize an artifact as a File (for downloads + Web Share). */
function artifactToFile(artifact: Artifact): File | null {
  try {
    if (artifact.content.startsWith('data:')) {
      const decoded = dataUrlToBlob(artifact.content);
      if (!decoded) return null;
      return new File([decoded.blob], downloadName(artifact, decoded.mime), { type: decoded.mime });
    }
    const mime = artifact.type === 'html' ? 'text/html' : 'text/plain';
    return new File([artifact.content], downloadName(artifact), { type: mime });
  } catch {
    return null;
  }
}

function downloadName(artifact: Artifact, mime?: string): string {
  return `${(artifact.title || artifact.id).replace(/[\\/:*?"<>|]+/g, '_')}.${extFor(artifact, mime)}`;
}

/** Download an artifact as a real file (data URLs are decoded to a Blob first). */
function downloadArtifactFile(artifact: Artifact) {
  // Content-addressed blobs live on the asset store behind an authed endpoint —
  // fetch the bytes (with the auth header) then save.
  if ((artifact.content ?? '').startsWith('asset://')) {
    void apiBlob(`/v1/artifacts/${artifact.id}/content?download=1`)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = downloadName(artifact);
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      })
      .catch(() => undefined);
    return;
  }
  const file = artifactToFile(artifact);
  const a = document.createElement('a');
  if (file) {
    const url = URL.createObjectURL(file);
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return;
  }
  // Last-resort fallback.
  a.href = artifact.content;
  a.download = downloadName(artifact);
  a.click();
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'text/html': 'html', 'text/csv': 'csv', 'application/json': 'json',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/webm': 'webm',
  'application/zip': 'zip', 'application/gzip': 'gz',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** A semi-ready chat prompt for iterating on an asset. The agent can load the
 * asset itself via agentis.assets.read using the `artifact:<id>` ref. */
function buildIterateDraft(a: Artifact): string {
  return `Iterate on the asset "${a.title}" (artifact:${a.id}). `;
}

function extFor(a: Artifact, mime?: string): string {
  if (mime && MIME_EXT[mime]) return MIME_EXT[mime];
  switch (a.type) {
    case 'html': return 'html';
    case 'image': return 'png';
    case 'pdf': return 'pdf';
    case 'spreadsheet': return a.content.startsWith('data:') ? 'xlsx' : 'csv';
    case 'audio': return 'mp3';
    case 'video': return 'mp4';
    case 'archive': return 'zip';
    case 'code': return 'txt';
    case 'data': return 'json';
    default: return 'txt';
  }
}

// Re-export so external imports stay terse.
export { ExternalLink };
