import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScopedBrainMap } from '../../src/components/brain/ScopedBrainMap';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api');
  return { ...actual, api: mocks.api };
});

vi.mock('../../src/components/brain/BrainStage', () => ({
  BrainStage: ({ brain, onSelect }: { brain: { layers: { memory: Array<{ label: string }> } }; onSelect: (id: string) => void }) => (
    <button type="button" data-testid="scoped-brain-stage" onClick={() => onSelect('memory:note-1')}>
      {brain.layers.memory.map((node) => node.label).join(', ')}
    </button>
  ),
}));

describe('<ScopedBrainMap />', () => {
  it('renders memory atoms returned for an agent or personal scope', async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/v1/personal-brain/graph/node/memory%3Anote-1') {
        return {
          node: {
            id: 'memory:note-1',
            atomId: 'note-1',
            atomKind: 'memory',
            label: 'Release preference',
            summary: 'Always include rollback steps.',
            confidence: 0.9,
            reinforceCount: 1,
            createdAt: '2026-05-26T00:00:00.000Z',
            updatedAt: '2026-05-26T00:00:00.000Z',
            metadata: {},
          },
          links: [],
          relatedNodes: [],
          content: 'Always include full rollback validation steps before a deployment.',
          provenance: {
            createdBy: 'You',
            createdAt: '2026-05-26T00:00:00.000Z',
            updatedAt: '2026-05-26T00:00:00.000Z',
            source: 'Personal note',
            reinforced: 1,
          },
          usedBy: [],
        };
      }
      return { graph: {
        nodes: [
          {
            id: 'core',
            atomId: 'core',
            atomKind: 'core',
            label: 'Personal brain',
            confidence: 1,
            reinforceCount: 1,
            createdAt: '2026-05-26T00:00:00.000Z',
            updatedAt: '2026-05-26T00:00:00.000Z',
            metadata: {},
          },
          {
            id: 'memory:note-1',
            atomId: 'note-1',
            atomKind: 'memory',
            label: 'Release preference',
            summary: 'Always include rollback steps.',
            confidence: 0.9,
            reinforceCount: 1,
            createdAt: '2026-05-26T00:00:00.000Z',
            updatedAt: '2026-05-26T00:00:00.000Z',
            metadata: {},
          },
        ],
        links: [],
        meta: {
          workspaceId: 'personal:user-1',
          scope: 'scoped',
          scopeId: 'user-1',
          atomCount: 1,
          linkCount: 0,
          lastActivityAt: '2026-05-26T00:00:00.000Z',
          adapterTypes: [],
        },
      } };
    });

    render(<ScopedBrainMap endpoint="/v1/personal-brain/graph" detailEndpoint="/v1/personal-brain/graph/node" layoutKey="personal" emptyMessage="No private notes." />);

    await waitFor(() => expect(screen.getByTestId('scoped-brain-stage')).toHaveTextContent('Release preference'));
    expect(mocks.api).toHaveBeenCalledWith('/v1/personal-brain/graph');
    fireEvent.click(screen.getByTestId('scoped-brain-stage'));
    await waitFor(() => expect(screen.getByLabelText('Atom content')).toHaveTextContent('full rollback validation'));
    expect(mocks.api).toHaveBeenCalledWith('/v1/personal-brain/graph/node/memory%3Anote-1');
    expect(screen.queryByText('Suggest related')).not.toBeInTheDocument();
    expect(screen.queryByText('Archive this atom')).not.toBeInTheDocument();
  });
});
