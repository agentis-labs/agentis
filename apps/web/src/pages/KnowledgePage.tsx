/**
 * KnowledgePage — workspace knowledge surface.
 *
 * Hosts the Documents / Bases panels. Knowledge is shared across the whole
 * workspace; every agent and workflow can draw on it.
 */

import { useSearchParams } from 'react-router-dom';
import { Tabs } from '../components/shared/Tabs';
import {
  WorkspaceKnowledgePanels,
  type WorkspaceKnowledgeTab,
} from '../components/knowledge/WorkspaceKnowledgePanels';

function normalizeTab(raw: string | null): WorkspaceKnowledgeTab {
  return raw === 'bases' ? 'bases' : 'documents';
}

export function KnowledgePage() {
  const [searchParams] = useSearchParams();
  const tab = normalizeTab(searchParams.get('tab'));

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-4">
        <h1 className="text-display text-text-primary">Knowledge</h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          Documents and knowledge bases shared across the workspace.
        </p>
      </div>
      <Tabs
        param="tab"
        value={tab}
        defaultValue="documents"
        tabs={[
          { value: 'documents', label: 'Documents' },
          { value: 'bases', label: 'Knowledge Bases' },
        ]}
        className="px-6"
      />
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <WorkspaceKnowledgePanels tab={tab} />
      </div>
    </div>
  );
}
