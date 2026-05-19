/**
 * KnowledgePage — DEPRECATED entry point. The unified Brain page now hosts
 * the Documents / Bases / Memory / Episodes panels at /brain?tab=*. This
 * route is kept as a thin redirect so deep links continue to land somewhere
 * useful while we migrate.
 *
 * Spec: docs/UIUX-refactor/BRAIN-PAGE-REDESIGN.md §4.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export function KnowledgePage() {
  const nav = useNavigate();
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('tab');
    const tab = value === 'bases' || value === 'memory' || value === 'episodes' ? value : 'documents';
    nav(`/brain?tab=${tab}`, { replace: true });
  }, [nav]);
  return null;
}
