/**
 * BrainPage — Global Brain (workspace-scoped intelligence surface).
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §5.3, §12.
 *
 * The app-level Brain is local and sharp. The Global Brain is strategic
 * and systemic — it shows the orchestrator's intelligence map and
 * cross-app intelligence flows.
 */

import { Brain as BrainIcon } from 'lucide-react';
import { BrainView } from '../components/brain/BrainView';

export function BrainPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line bg-surface px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-card bg-fuchsia-500/15 text-fuchsia-300">
            <BrainIcon size={18} />
          </span>
          <div>
            <h1 className="text-display text-text-primary">The Brain</h1>
            <div className="mt-0.5 text-[12px] text-text-muted">
              Workspace orchestrator · cross-app intelligence map
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <BrainView slug={null} />
      </div>
    </div>
  );
}
