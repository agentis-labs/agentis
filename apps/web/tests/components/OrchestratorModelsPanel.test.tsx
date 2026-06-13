/**
 * OrchestratorModelsPanel — per-workspace model-role config (§4.4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorModelsPanel } from '../../src/components/settings/OrchestratorModelsPanel';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ROLES = [
  { role: 'conversation', envModel: 'gpt-4o-mini', effectiveModel: 'gpt-4o-mini', override: null },
  { role: 'planning', envModel: 'gpt-4o-mini', effectiveModel: 'gpt-4o-mini', override: null },
  { role: 'synthesis', envModel: null, effectiveModel: null, override: null },
  { role: 'evaluation', envModel: null, effectiveModel: null, override: null },
  { role: 'vision', envModel: null, effectiveModel: null, override: null },
  { role: 'transcription', envModel: null, effectiveModel: null, override: null },
];

describe('<OrchestratorModelsPanel />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('lists all six roles with their effective model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ roles: ROLES })));
    render(<OrchestratorModelsPanel />);
    await waitFor(() => expect(screen.getByText('Conversation')).toBeInTheDocument());
    for (const title of ['Planning', 'Synthesis', 'Evaluation', 'Vision', 'Transcription']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it('shows the autonomy banner when no model is resolvable', async () => {
    const noModelRoles = ROLES.map((r) => ({ ...r, envModel: null, effectiveModel: null }));
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ roles: noModelRoles, autonomy: { enabled: false, model: null } })));
    render(<OrchestratorModelsPanel />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/No autonomy model is configured/i)).toBeInTheDocument();
  });

  it('hides the autonomy banner when a model is resolvable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ roles: ROLES, autonomy: { enabled: true, model: 'gpt-4o-mini' } })));
    render(<OrchestratorModelsPanel />);
    await waitFor(() => expect(screen.getByText('Conversation')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('overrides the conversation model via PUT', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') {
        puts.push({ url, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ role: { role: 'conversation', model: 'claude-opus-4-8', hasApiKey: false } });
      }
      return jsonResponse({ roles: ROLES });
    }));

    render(<OrchestratorModelsPanel />);
    await waitFor(() => expect(screen.getByText('Conversation')).toBeInTheDocument());

    // Open the conversation override editor (first "Override" button).
    await userEvent.click(screen.getAllByRole('button', { name: /Override/i })[0]);
    const modelInput = screen.getByPlaceholderText('gpt-4o-mini');
    await userEvent.clear(modelInput);
    await userEvent.type(modelInput, 'claude-opus-4-8');
    await userEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.url).toBe('/v1/orchestrator/models/conversation');
    expect(puts[0]!.body).toMatchObject({ model: 'claude-opus-4-8' });
  });
});
