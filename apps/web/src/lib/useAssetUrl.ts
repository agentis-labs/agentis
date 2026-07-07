import { useEffect, useState } from 'react';
import { apiBlob } from './api';

/**
 * Resolve an artifact's binary content to a URL usable in <img>/<video>/<iframe>.
 *
 * Content-addressed assets store `asset://<hash>` in `artifact.content`, which is
 * NOT directly renderable — the bytes live on the asset store behind an authed
 * endpoint. This hook fetches `/v1/artifacts/:id/content` (or `/thumbnail`) with
 * the auth header and hands back an object URL, revoked on unmount. Legacy inline
 * `data:`/`http(s)` content is returned as-is with no fetch.
 */
export function useAssetUrl(
  artifact: { id: string; content?: string | null } | null | undefined,
  opts: { thumbnail?: boolean } = {},
): { url: string | null; loading: boolean; error: boolean } {
  const content = artifact?.content ?? '';
  const id = artifact?.id ?? '';
  const inline = content.startsWith('data:') || /^https?:\/\//i.test(content);
  const [url, setUrl] = useState<string | null>(inline ? content : null);
  const [loading, setLoading] = useState(!inline && Boolean(id));
  const [error, setError] = useState(false);

  useEffect(() => {
    if (inline) {
      setUrl(content);
      setLoading(false);
      setError(false);
      return;
    }
    if (!id) {
      setUrl(null);
      setLoading(false);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    setLoading(true);
    setError(false);
    const endpoint = opts.thumbnail ? `/v1/artifacts/${id}/thumbnail` : `/v1/artifacts/${id}/content`;
    apiBlob(endpoint)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, content, inline, opts.thumbnail]);

  return { url, loading, error };
}
