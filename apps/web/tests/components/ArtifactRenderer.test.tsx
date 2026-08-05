import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ArtifactRenderer, artifactPreviewKind } from '../../src/components/ArtifactPanel/ArtifactPanel';
import type { Artifact } from '../../src/components/ArtifactPanel/types';

function artifact(patch: Partial<Artifact>): Artifact {
  return {
    id: 'artifact-1', workspaceId: 'ws-1', userId: 'user-1', runId: null,
    workflowId: null, agentId: null, appId: null, conversationId: null, nodeId: null,
    origin: 'manual', type: 'document', title: 'Report', content: 'hello', thumbnailUrl: null,
    metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch,
  };
}

describe('<ArtifactRenderer />', () => {
  it('selects previews using original filename and MIME metadata', () => {
    const value = artifact({ type: 'document', metadata: { name: 'report.md', mime: 'text/markdown' } });
    expect(artifactPreviewKind(value, 'text/markdown', 'report.md')).toBe('markdown');
    expect(artifactPreviewKind(artifact({ type: 'spreadsheet' }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'book.xlsx')).toBe('binary');
  });

  it('loads authenticated asset markdown instead of rendering its asset reference', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('# Persisted plan\n\nReal content', { headers: { 'content-type': 'text/markdown' } }));
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:artifact'), revokeObjectURL: vi.fn() });
    render(<ArtifactRenderer artifact={artifact({ content: 'asset://abc', metadata: { name: 'plan.md', mime: 'text/markdown' } })} />);
    await waitFor(() => expect(screen.getByText('Persisted plan')).toBeInTheDocument());
    expect(screen.queryByText('asset://abc')).not.toBeInTheDocument();
  });

  it('renders CSV and malformed JSON without losing download access', async () => {
    const { rerender } = render(<ArtifactRenderer artifact={artifact({ type: 'data', content: 'name,value\nalpha,1', metadata: { name: 'rows.csv', mime: 'text/csv' } })} />);
    expect(screen.getByRole('columnheader', { name: 'name' })).toBeInTheDocument();
    rerender(<ArtifactRenderer artifact={artifact({ type: 'data', content: '{broken', metadata: { name: 'broken.json', mime: 'application/json' } })} />);
    expect(screen.getByText('{broken')).toBeInTheDocument();
  });
});
