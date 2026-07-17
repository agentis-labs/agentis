import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { api } from '../../lib/api';
import { useAssetUrl } from '../../lib/useAssetUrl';

export type ChatArtifact = {
  id: string;
  type: 'html' | 'image' | 'document' | 'code' | 'data';
  title: string;
  content: string;
};

export function collectArtifactIds(value: unknown, out: Set<string>): void {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectArtifactIds(item, out));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'artifactId' && typeof nested === 'string' && nested.trim()) {
      out.add(nested.trim());
      continue;
    }
    if (key === 'artifactIds' && Array.isArray(nested)) {
      nested.forEach((item) => {
        if (typeof item === 'string' && item.trim()) out.add(item.trim());
      });
      continue;
    }
    if ((key === 'ref' || key === 'url') && typeof nested === 'string') {
      const artifactId = artifactIdFromRef(nested);
      if (artifactId) out.add(artifactId);
    }
    collectArtifactIds(nested, out);
  }
}

export function artifactIdFromRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^artifact:/i.test(trimmed)) return trimmed.slice('artifact:'.length).trim() || null;
  const match = trimmed.match(/^(?:https?:\/\/[^/]+)?\/v1\/artifacts\/([0-9a-f-]{36})(?:[/?#].*)?$/i);
  return match?.[1] ?? null;
}

/**
 * Artifact previews need to load through `api()` so requests carry the
 * workspace Bearer token instead of opening raw `/v1/artifacts/:id` links.
 */
export function ChatArtifactAttachments({ artifactIds }: { artifactIds: string[] }) {
  const artifactKey = artifactIds.join(',');
  const [artifacts, setArtifacts] = useState<ChatArtifact[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!artifactIds.length) {
      setArtifacts([]);
      return () => { cancelled = true; };
    }
    void Promise.all(
      artifactIds.map(async (id) => {
        const response = await api<{ artifact: ChatArtifact }>(`/v1/artifacts/${encodeURIComponent(id)}`);
        return response.artifact;
      }),
    ).then((loaded) => {
      if (!cancelled) setArtifacts(loaded);
    }).catch(() => {
      if (!cancelled) setArtifacts([]);
    });
    return () => { cancelled = true; };
  }, [artifactKey]); // artifactKey is the stable identity of the requested artifacts.

  if (!artifacts.length) return null;
  return (
    <div className="mb-2 grid gap-2 sm:grid-cols-2">
      {artifacts.map((artifact) => (
        <ChatArtifactCard key={artifact.id} artifact={artifact} />
      ))}
    </div>
  );
}

/**
 * Content-addressed assets store `asset://<hash>` in `artifact.content`, which
 * isn't directly renderable in an `<img>` — resolve it through `useAssetUrl`
 * (authed fetch → object URL) so both agent-generated media and user-uploaded
 * chat attachments render inline, not just legacy inline `data:` artifacts.
 */
function ChatArtifactCard({ artifact }: { artifact: ChatArtifact }) {
  const isImage = artifact.type === 'image';
  const { url } = useAssetUrl(isImage ? artifact : null, { thumbnail: true });
  return (
    <Link
      to={`/artifacts?open=${encodeURIComponent(artifact.id)}`}
      className="group overflow-hidden rounded-lg border border-line bg-canvas/50 text-left transition hover:border-accent/50 hover:bg-canvas"
    >
      {isImage && url && (
        <img
          src={url}
          alt={artifact.title}
          className="max-h-64 w-full bg-canvas object-contain"
        />
      )}
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2 text-[11px]">
        <FileText size={13} className="shrink-0 text-accent" />
        <span className="truncate font-medium text-text-primary">{artifact.title}</span>
        <span className="ml-auto shrink-0 uppercase tracking-wide text-text-muted">{artifact.type}</span>
      </div>
    </Link>
  );
}
