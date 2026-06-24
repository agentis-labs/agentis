import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AbilityDetailPage } from '../../src/pages/AbilityDetailPage';
import { ToastProvider } from '../../src/components/shared/Toast';
import { ConfirmProvider } from '../../src/components/shared/ConfirmDialog';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildAbilityFetchMock() {
  let ability = {
    id: 'ab-1',
    workspaceId: 'ws-1',
    name: 'Foundry',
    slug: 'foundry',
    description: 'A specialist for shaping product thinking.',
    domainTag: 'design',
    iconEmoji: 'F',
    compiledPrompt: 'Auto persona',
    specs: { stack: 'React' },
    rulesAlways: ['Stay precise'],
    rulesNever: ['Invent metrics'],
    toolHints: ['read_file'],
    exampleCount: 0,
    knowledgeCount: 0,
    compileStatus: 'ready',
    compileStage: null,
    compileCancelRequested: false,
    lastCompiledAt: '2026-06-18T10:00:00.000Z',
    compileError: null,
    isPublic: false,
    hubSlug: null,
    hubVersion: '0.0.0',
    installCount: 0,
    tokenBudget: 2400,
    version: '1.0.0',
    kbDocumentId: null,
    createdAt: '2026-06-18T09:00:00.000Z',
    updatedAt: '2026-06-18T10:00:00.000Z',
  };
  let knowledge: Array<{
    id: string;
    abilityId: string;
    kbChunkId: string | null;
    title: string | null;
    content: string;
    contextPrefix: string | null;
    sourceType: 'document' | 'image' | 'audio' | 'url' | 'manual';
    sourceUrl: string | null;
    importanceScore: number;
    createdAt: string;
  }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/v1/abilities/compile-config') {
      return jsonResponse({
        workspace: null,
        env: null,
        hasModel: true,
        catalog: { adapterType: 'codex', models: [] },
      });
    }
    if (path === '/v1/abilities/ab-1' && (!init?.method || init.method === 'GET')) {
      return jsonResponse({ ability });
    }
    if (path === '/v1/abilities/ab-1/examples') {
      return jsonResponse({ examples: [] });
    }
    if (path === '/v1/abilities/ab-1/knowledge' && (!init?.method || init.method === 'GET')) {
      return jsonResponse({ knowledge });
    }
    if (path === '/v1/abilities/ab-1/knowledge/upload' && init?.method === 'POST') {
      const entry = {
        id: `kn-${knowledge.length + 1}`,
        abilityId: 'ab-1',
        kbChunkId: null,
        title: `Upload ${knowledge.length + 1}`,
        content: 'Uploaded content',
        contextPrefix: null,
        sourceType: 'image' as const,
        sourceUrl: null,
        importanceScore: 0.6,
        createdAt: '2026-06-19T10:00:00.000Z',
      };
      knowledge = [...knowledge, entry];
      ability = {
        ...ability,
        knowledgeCount: knowledge.length,
        updatedAt: '2026-06-19T10:00:00.000Z',
      };
      return jsonResponse({ knowledge: entry }, 201);
    }
    if (path === '/v1/abilities/ab-1' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      ability = {
        ...ability,
        ...body,
        updatedAt: '2026-06-19T10:00:00.000Z',
      };
      return jsonResponse({ ability });
    }
    if (path === '/v1/agents') {
      return jsonResponse({ agents: [] });
    }
    return jsonResponse({});
  });

  return { fetchMock };
}

function renderAbilityPage(fetchMock: ReturnType<typeof vi.fn>) {
  localStorage.setItem('agentis.access', 'access-token');
  localStorage.setItem('agentis.workspace', 'ws-1');
  vi.stubGlobal('fetch', fetchMock);
  render(
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/abilities/ab-1']}>
          <Routes>
            <Route path="/abilities/:id" element={<AbilityDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

describe('<AbilityDetailPage />', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('does not save token budget on the first keystroke', async () => {
    const user = userEvent.setup();
    const { fetchMock } = buildAbilityFetchMock();
    renderAbilityPage(fetchMock);

    await waitFor(() => expect(screen.getByText('Foundry')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^Settings$/i }));

    const budgetInput = screen.getByPlaceholderText(/Inherit workspace default/i);
    await user.clear(budgetInput);
    await user.type(budgetInput, '1');

    const patchCallsBeforeSave = fetchMock.mock.calls.filter(
      ([url, init]) => String(url) === '/v1/abilities/ab-1' && init?.method === 'PATCH',
    );
    expect(patchCallsBeforeSave).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === '/v1/abilities/ab-1' && init?.method === 'PATCH',
      );
      expect(patchCalls).toHaveLength(1);
      expect(String(patchCalls[0]?.[1]?.body)).toContain('"tokenBudget":1');
    });
  });

  it('keeps unsaved draft edits after saving token budget', async () => {
    const user = userEvent.setup();
    const { fetchMock } = buildAbilityFetchMock();
    renderAbilityPage(fetchMock);

    await waitFor(() => expect(screen.getByText('Foundry')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^Persona$/i }));

    const nameInput = screen.getByPlaceholderText(/Senior UI Engineer/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Signal Architect');

    await user.click(screen.getByRole('button', { name: /^Settings$/i }));
    const budgetInput = screen.getByPlaceholderText(/Inherit workspace default/i);
    await user.clear(budgetInput);
    await user.type(budgetInput, '3000');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === '/v1/abilities/ab-1' && init?.method === 'PATCH',
      );
      expect(patchCalls).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: /^Persona$/i }));
    expect(screen.getByDisplayValue('Signal Architect')).toBeInTheDocument();
  });

  it('prevents default browser navigation when dropping a reference file', async () => {
    const user = userEvent.setup();
    const { fetchMock } = buildAbilityFetchMock();
    renderAbilityPage(fetchMock);

    await waitFor(() => expect(screen.getByText('Foundry')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^References$/i }));

    const file = new File(['image-bytes'], 'diagram.png', { type: 'image/png' });
    const zoneLabel = screen.getByText(/Drag & drop documents here or click to browse/i).closest('label');
    expect(zoneLabel).not.toBeNull();
    const zone = zoneLabel?.parentElement as HTMLElement;

    const event = createEvent.drop(zone, {
      dataTransfer: {
        files: [file],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        types: ['Files'],
      },
    });
    await act(async () => {
      fireEvent(zone, event);
    });

    expect(event.defaultPrevented).toBe(true);
  });
});
