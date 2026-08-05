import { useEffect, useMemo, useState } from 'react';
import { apiBlob } from './api';

export interface ArtifactContentSource {
  id: string;
  type?: string;
  title?: string;
  content?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LoadedArtifactContent {
  text: string | null;
  url: string | null;
  mime: string;
  filename: string;
  loading: boolean;
  error: string | null;
}

function metadataString(metadata: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function artifactFilename(artifact: ArtifactContentSource): string {
  return metadataString(artifact.metadata, 'name', 'filename', 'fileName', 'originalName')
    || artifact.title?.trim()
    || artifact.id;
}

export function artifactMime(artifact: ArtifactContentSource): string {
  return metadataString(artifact.metadata, 'mime', 'mimeType', 'contentType').toLowerCase();
}

export function isTextualArtifact(artifact: ArtifactContentSource, mime = artifactMime(artifact)): boolean {
  const filename = artifactFilename(artifact).toLowerCase();
  if (mime.startsWith('text/') || /(?:json|javascript|typescript|xml|yaml|toml)$/.test(mime)) return true;
  if (/\.(?:md|markdown|mdx|txt|log|html?|css|js|jsx|ts|tsx|json|jsonl|csv|tsv|xml|ya?ml|toml|sql|sh|py|rb|go|rs|java|c|cpp|h)$/i.test(filename)) return true;
  return ['document', 'code', 'data', 'html'].includes(artifact.type ?? '');
}

function decodeDataUrl(source: string): Blob {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(source);
  if (!match) throw new Error('Malformed data URL');
  const mime = match[1] || 'application/octet-stream';
  const payload = match[3] ?? '';
  if (!match[2]) return new Blob([decodeURIComponent(payload)], { type: mime });
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

/** Load inline and content-addressed artifacts through one lifecycle. */
export function useArtifactContent(artifact: ArtifactContentSource): LoadedArtifactContent {
  const source = artifact.content ?? '';
  const filename = artifactFilename(artifact);
  const declaredMime = artifactMime(artifact);
  const isInlineText = source !== '' && !source.startsWith('asset://') && !source.startsWith('data:') && !/^https?:\/\//i.test(source);
  const textual = isTextualArtifact(artifact, declaredMime);
  const [state, setState] = useState<Omit<LoadedArtifactContent, 'filename'>>({
    text: isInlineText ? source : null,
    url: /^https?:\/\//i.test(source) && !textual ? source : null,
    mime: declaredMime || (isInlineText ? 'text/plain' : ''),
    loading: !isInlineText && Boolean(source),
    error: source ? null : 'This artifact has no content.',
  });

  useEffect(() => {
    if (isInlineText) {
      setState({ text: source, url: null, mime: declaredMime || 'text/plain', loading: false, error: null });
      return;
    }
    if (!source) {
      setState({ text: null, url: null, mime: declaredMime, loading: false, error: 'This artifact has no content.' });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setState((current) => ({ ...current, loading: true, error: null }));
    const load = async () => {
      let blob: Blob;
      if (source.startsWith('asset://')) blob = await apiBlob(`/v1/artifacts/${artifact.id}/content`);
      else if (source.startsWith('data:')) blob = decodeDataUrl(source);
      else {
        const response = await fetch(source, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Remote source returned ${response.status}`);
        blob = await response.blob();
      }
      if (cancelled) return;
      const mime = (blob.type || declaredMime || 'application/octet-stream').toLowerCase();
      const shouldDecode = isTextualArtifact(artifact, mime);
      const text = shouldDecode ? await blob.text() : null;
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setState({ text, url: objectUrl, mime, loading: false, error: null });
    };
    void load().catch((error: unknown) => {
      if (cancelled) return;
      setState({
        text: null,
        url: /^https?:\/\//i.test(source) && !textual ? source : null,
        mime: declaredMime,
        loading: false,
        error: error instanceof Error ? error.message : 'Could not load artifact content.',
      });
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id, declaredMime, isInlineText, source, textual]);

  return useMemo(() => ({ ...state, filename }), [filename, state]);
}
