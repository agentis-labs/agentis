import { useEffect, useRef } from 'react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from './api';
import { rtSubscribe, useRealtime } from './realtime';
import { useToast } from '../components/shared/Toast';

interface PromotionEvent {
  id: string;
  runId?: string | null;
  decision?: string;
  candidate?: { title?: string; summary?: string; type?: string };
  promotedEntryId?: string | null;
  createdAt?: string;
}

export function useMemoryPromotionNotifier() {
  const toast = useToast();
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => rtSubscribe('workspace', {}), []);

  useRealtime([REALTIME_EVENTS.RUN_COMPLETED], (env) => {
    const payload = env.payload as { runId?: string; id?: string } | undefined;
    const runId = payload?.runId ?? payload?.id;
    if (!runId) return;
    void api<{ events: PromotionEvent[] }>(`/v1/memory/promotions?runId=${encodeURIComponent(runId)}&limit=3`)
      .then((data) => {
        const event = (data.events ?? []).find((item) => (item.promotedEntryId || item.decision === 'promoted' || item.decision === 'merged') && !seen.current.has(item.id));
        if (!event) return;
        seen.current.add(event.id);
        const label = event.candidate?.title ?? event.candidate?.summary ?? 'A workflow lesson was saved';
        toast.info('Memory promoted', label);
      })
      .catch(() => {});
  });
}