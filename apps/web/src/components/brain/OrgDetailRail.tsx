/**
 * Organizational detail rail â€” the deep-reading surface for the Workspace
 * Brain Map's organizational overlay (RFC Â§14.4 detail-rail modes).
 *
 * Renders claim / source / entity inspectors: confidence components, grounded
 * citations with native links, dispute state, approve/reject governance, and
 * the Â§14.5 bridge â€” "Discuss in chat" hands the node to the orchestrator
 * (`/chat?draft=â€¦`) instead of duplicating a second ask surface in the map.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Check, ExternalLink, Loader2, MessageSquare, Scale, ShieldAlert, X,
} from 'lucide-react';
import type { BrainNode } from '@agentis/core';
import { api, apiErrorMessage } from '../../lib/api';
import { useChatPanelStore } from '../chat/ChatPanelStore';

interface ClaimDetail {
  claim: {
    id: string;
    predicate: string;
    objectJson: unknown;
    claimType: string;
    status: string;
    confidence: number;
    confidenceJson: Record<string, number>;
    protectedDomain: boolean;
    validFrom: string | null;
  };
  evidence: Array<{
    id: string;
    role: string;
    independenceKey: string | null;
    citation: {
      title: string;
      nativeUrl: string | null;
      objectType: string;
      observedAt: string;
      live: boolean;
    } | null;
  }>;
}

const COMPONENT_LABELS: Record<string, string> = {
  corroboration: 'Corroboration',
  sourceReliability: 'Source reliability',
  directness: 'Directness',
  freshness: 'Freshness',
  consistency: 'Consistency',
  contradictionPenalty: 'Contradiction penalty',
};

export function OrgDetailRail({ node, onClose, onChanged }: {
  node: BrainNode;
  onClose: () => void;
  onChanged: () => void;
}) {
  const groundingKind = String(node.metadata?.grounding ?? '');
  const rawId = String(node.metadata?.atomId ?? node.id.split(':').pop() ?? '');
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (groundingKind !== 'claim' || !rawId) return;
    void api<ClaimDetail>(`/v1/grounding/claims/${rawId}`)
      .then(setDetail)
      .catch((err) => setError(apiErrorMessage(err)));
  }, [groundingKind, rawId]);

  const discussInChat = useCallback(() => {
    const summary = node.description ? ` â€” ${node.description}` : '';
    const draft = groundingKind === 'claim'
      ? `About the organizational claim "${node.label}"${summary}: explain what supports it, what contradicts it, and whether it is still current.`
      : groundingKind === 'source'
        ? `What has the Brain learned from the ${node.label} source so far, and what is it missing?`
        : `Tell me what the Brain knows about "${node.label}"${summary}, with citations.`;
    useChatPanelStore.getState().openChat({
      state: 'fullscreen',
      thread: null,
      launchContext: { initialDraft: draft },
    });
  }, [groundingKind, node]);

  const setClaimStatus = useCallback(async (action: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/grounding/claims/${rawId}/${action}`, { method: 'POST' });
      onChanged();
      if (action === 'reject') onClose();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [rawId, onChanged, onClose]);

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            {groundingKind === 'claim' ? 'Organizational claim' : groundingKind === 'source' ? 'Connected source' : 'Organizational entity'}
          </p>
          <h3 className="truncate text-[14px] font-semibold text-text-primary">{node.label}</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-btn p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary">
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[12px]">
        {node.description && <p className="text-text-muted">{node.description}</p>}

        {groundingKind === 'claim' && (
          <>
            {!detail && !error && (
              <p className="mt-4 inline-flex items-center gap-2 text-text-muted"><Loader2 size={13} className="animate-spin" /> Loading claimâ€¦</p>
            )}
            {detail && (
              <>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-pill px-2 py-0.5 text-[10px] font-semibold ${
                    detail.claim.status === 'active' ? 'bg-emerald-500/10 text-emerald-500'
                    : detail.claim.status === 'disputed' ? 'bg-amber-500/10 text-amber-500'
                    : 'bg-surface-2 text-text-muted'
                  }`}>{detail.claim.status}</span>
                  <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted">{detail.claim.claimType}</span>
                  {detail.claim.protectedDomain && (
                    <span className="inline-flex items-center gap-1 rounded-pill bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-500">
                      <ShieldAlert size={10} /> protected
                    </span>
                  )}
                </div>

                <h4 className="mt-4 text-[11px] font-semibold text-text-muted">Why this confidence ({Math.round(detail.claim.confidence * 100)}%)</h4>
                <div className="mt-1.5 grid gap-1.5">
                  {Object.entries(detail.claim.confidenceJson ?? {}).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className="w-[130px] shrink-0 text-[11px] text-text-muted">{COMPONENT_LABELS[key] ?? key}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-pill bg-surface-2">
                        <div
                          className={`h-full rounded-pill ${key === 'contradictionPenalty' ? 'bg-rose-400' : 'bg-accent'}`}
                          style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <h4 className="mt-4 text-[11px] font-semibold text-text-muted">Evidence ({detail.evidence.length})</h4>
                <div className="mt-1.5 grid gap-1.5">
                  {detail.evidence.map((row) => (
                    <div key={row.id} className={`rounded-card border px-2.5 py-2 ${row.role === 'contradicts' ? 'border-rose-400/30 bg-rose-500/5' : 'border-line bg-surface-2'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[12px] text-text-primary">{row.citation?.title ?? 'Evidence'}</span>
                        {row.citation?.nativeUrl && (
                          <a href={row.citation.nativeUrl} className="shrink-0 text-text-muted hover:text-accent" aria-label="Open source">
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] text-text-muted">
                        {row.role}{row.citation ? ` Â· ${row.citation.objectType} Â· ${row.citation.live ? 'live' : 'historical'}` : ''}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex gap-2">
                  {detail.claim.status !== 'active' && (
                    <button type="button" disabled={busy} onClick={() => void setClaimStatus('approve')} className="inline-flex items-center gap-1.5 rounded-btn bg-accent-soft px-2.5 py-1.5 text-[11px] font-semibold text-accent disabled:opacity-50">
                      <Check size={12} /> Approve
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => void setClaimStatus('reject')} className="inline-flex items-center gap-1.5 rounded-btn border border-line px-2.5 py-1.5 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-50">
                    <X size={12} /> Reject
                  </button>
                </div>
                {detail.claim.status === 'disputed' && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-amber-500"><Scale size={11} /> Conflicting claims exist â€” resolve in Insights â†’ Disputes.</p>
                )}
              </>
            )}
          </>
        )}

        {groundingKind === 'source' && (
          <div className="mt-3 grid gap-1 text-[12px] text-text-muted">
            <p>Status: <strong className="text-text-primary">{String(node.metadata?.status ?? 'unknown')}</strong></p>
            <p>Type: {String(node.metadata?.sourceType ?? 'unknown')}</p>
            <p className="mt-1">Manage scopes, briefs, and sync from the <a href="/brain?tab=sources" className="text-accent">Sources tab</a>.</p>
          </div>
        )}

        {groundingKind === 'entity' && (
          <p className="mt-3 text-text-muted">Kind: <strong className="text-text-primary">{String(node.metadata?.kind ?? 'entity')}</strong>. Claims about this entity appear as connected judgment nodes.</p>
        )}

        {error && <p className="mt-3 text-[11px] text-rose-400">{error}</p>}
      </div>

      <footer className="border-t border-line px-4 py-3">
        <button
          type="button"
          onClick={discussInChat}
          className="inline-flex w-full items-center justify-center gap-2 rounded-btn bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:opacity-90"
        >
          <MessageSquare size={13} /> Discuss in chat
        </button>
      </footer>
    </aside>
  );
}



