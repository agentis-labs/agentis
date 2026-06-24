import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainView } from '../../src/components/brain/BrainView';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api');
  return { ...actual, api: mocks.api };
});

vi.mock('../../src/lib/realtime', () => ({
  rtSubscribe: vi.fn(() => vi.fn()),
  useRealtime: vi.fn(),
}));

vi.mock('../../src/components/brain/BrainStage', () => ({
  BrainStage: ({ brain }: { brain: { layers: { knowledge: Array<{ label: string }> } } }) => (
    <div data-testid="brain-stage">{brain.layers.knowledge.map((node) => node.label).join(', ')}</div>
  ),
}));

describe('<BrainView />', () => {
  beforeEach(() => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/v1/brain') {
        return {
          scope: 'workspace',
          stats: {
            knowledgeNodes: 0,
            memoryNodes: 0,
            evaluatorNodes: 0,
            baselineConfidence: null,
            staleSources: 0,
          },
          layers: { core: [], knowledge: [], memory: [], judgment: [] },
          edges: [],
          warnings: [],
          gaps: [],
        };
      }
      if (path === '/v1/brain/graph') {
        return {
          graph: {
            nodes: [
              {
                id: 'core',
                atomId: 'core',
                atomKind: 'core',
                label: 'Workspace brain',
                confidence: 1,
                reinforceCount: 1,
                createdAt: '2026-05-25T00:00:00.000Z',
                updatedAt: '2026-05-25T00:00:00.000Z',
                metadata: {},
              },
              {
                id: 'kb_chunk:chunk-1',
                atomId: 'chunk-1',
                atomKind: 'kb_chunk',
                label: 'product-notes.txt',
                summary: 'Indexed workspace document content',
                confidence: 0.82,
                reinforceCount: 1,
                createdAt: '2026-05-25T00:00:00.000Z',
                updatedAt: '2026-05-25T00:00:00.000Z',
                metadata: {},
              },
            ],
            links: [],
            meta: {
              workspaceId: 'workspace-1',
              scope: 'workspace',
              atomCount: 1,
              linkCount: 0,
              lastActivityAt: '2026-05-25T00:00:00.000Z',
              adapterTypes: [],
            },
          },
        };
      }
      if (path === '/v1/workspace/intelligence') {
        return { embeddingProviderType: 'local', degraded: false, migration: null };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it('renders indexed document atoms even when composed knowledge layers are empty', async () => {
    render(
      <MemoryRouter>
        <BrainView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('brain-stage')).toHaveTextContent('product-notes.txt'));
    expect(screen.queryByText('The workspace brain is empty.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search the brain' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Knowledge/ })).toBeInTheDocument();
    expect(screen.queryByText('1 knowledge - 0 memories - 0 links')).not.toBeInTheDocument();
  });
});
