import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentMemoryIngestPanel } from '../../src/components/agents/AgentMemoryIngestPanel';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const preview = {
  agentId: 'agent-1',
  scannedFiles: [{ fileName: 'CLAUDE.md', source: 'runtime', candidateCount: 2, skipped: false }],
  minQuality: 0.55,
  candidates: [
    { hash: 'h1', title: 'Rules: Always run tests', summary: 'Always run the test suite before pushing.', type: 'distilled_lesson', section: 'Rules', quality: 0.82, duplicateOf: null, origin: { adapterType: 'claude_code', fileName: 'CLAUDE.md' } },
    { hash: 'h2', title: 'Known fact', summary: 'We deploy on Fridays.', type: 'distilled_lesson', section: 'Notes', quality: 0.6, duplicateOf: { episodeId: 'e9', kind: 'semantic' }, origin: { adapterType: 'claude_code', fileName: 'CLAUDE.md' } },
  ],
};

describe('<AgentMemoryIngestPanel />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  it('scans, pre-selects new (non-duplicate) candidates, and imports them', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, method: init?.method, body: init?.body as string });
      if (path.includes('/memory/ingest/preview')) return jsonResponse(preview);
      if (path.includes('/memory/ingest')) return jsonResponse({ written: 1, reinforced: 0, skipped: 0, episodeIds: ['x'] });
      return jsonResponse({});
    }));

    render(<AgentMemoryIngestPanel agentId="agent-1" />);

    fireEvent.click(screen.getByRole('button', { name: /scan harness memory/i }));
    await waitFor(() => expect(screen.getByText(/Always run the test suite/)).toBeInTheDocument());

    // Duplicate candidate is flagged.
    expect(screen.getByText('already known')).toBeInTheDocument();
    // New candidate pre-selected → 1 of 2.
    expect(screen.getByText('1 selected of 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /import selected/i }));
    await waitFor(() => expect(screen.getByText(/Imported 1 memory into the Brain/i)).toBeInTheDocument());

    const commit = calls.find((c) => c.method === 'POST' && c.path.includes('/memory/ingest') && !c.path.includes('preview'));
    expect(commit).toBeTruthy();
    expect(JSON.parse(commit!.body!).acceptHashes).toEqual(['h1']);
  });

  it('shows an empty message when no candidates are found', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/memory/ingest/preview')) return jsonResponse({ ...preview, candidates: [] });
      return jsonResponse({});
    }));
    render(<AgentMemoryIngestPanel agentId="agent-1" />);
    fireEvent.click(screen.getByRole('button', { name: /scan harness memory/i }));
    await waitFor(() => expect(screen.getByText(/No new harness memory found/i)).toBeInTheDocument());
  });
});
