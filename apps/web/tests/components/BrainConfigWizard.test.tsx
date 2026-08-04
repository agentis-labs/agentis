import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainConfigWizard } from '../../src/components/brain/BrainConfigWizard';
import { ToastProvider } from '../../src/components/shared/Toast';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api');
  return { ...actual, api: mocks.api };
});

const degradedRuntime = {
  status: 'degraded',
  model: 'Xenova/multilingual-e5-small',
  revision: 'pinned-revision',
  dtype: 'q8',
  progress: 73,
  retryAt: '2026-08-04T12:00:00.000Z',
  errorCode: 'EMBEDDING_CHECKSUM_MISMATCH',
  error: 'Checksum mismatch for onnx/model_quantized.onnx.',
  artifacts: [
    { file: 'config.json', expectedBytes: 1, downloadedBytes: 1, ready: true },
    { file: 'onnx/model_quantized.onnx', expectedBytes: 10, downloadedBytes: 7, ready: false },
  ],
  pending: { memories: 280, sessionMoments: 8, total: 288 },
};

describe('<BrainConfigWizard /> embedding recovery', () => {
  beforeEach(() => {
    let runtime = degradedRuntime;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/v1/workspace/intelligence') return {
        embeddingProviderType: 'local',
        embeddingProviderConfig: {},
        enrichmentConfig: {},
        activeAtomCount: 288,
        degraded: runtime.status !== 'ready',
        runtime,
      };
      if (path === '/v1/runtime/embedding' && !init?.method) return runtime;
      if (path === '/v1/runtime/embedding/retry') {
        runtime = { ...degradedRuntime, status: 'ready', progress: 100, errorCode: null, error: null, pending: { memories: 0, sessionMoments: 0, total: 0 } } as typeof degradedRuntime;
        return { ok: true, runtime };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it('shows the real phase, failure artifact, backlog, and recovery actions', async () => {
    render(<ToastProvider><BrainConfigWizard embedded /></ToastProvider>);

    expect(await screen.findByText('Semantic runtime degraded')).toBeInTheDocument();
    expect(screen.getByText('288 records waiting for semantic indexing')).toBeInTheDocument();
    expect(screen.getByText('EMBEDDING_CHECKSUM_MISMATCH')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preserve & repair cache' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/v1/runtime/embedding/retry', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText('Semantic runtime ready')).toBeInTheDocument();
    expect(screen.getByText('Deferred indexing is clear')).toBeInTheDocument();
  });
});
