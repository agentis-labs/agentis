import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RuntimeDescriptor, RuntimeResourceDescriptor } from '@agentis/core';
import { RuntimeNativePanel } from '../../src/components/agents/RuntimeNativePanel';
import { ToastProvider } from '../../src/components/shared/Toast';

const overlay = resource({
  id: 'agentis:overlay',
  name: 'agentis.md',
  kind: 'generated_overlay',
  scope: 'agent',
  origin: 'agentis',
  checksum: 'overlay-checksum',
});
const soul = resource({
  id: 'file:soul',
  name: 'SOUL.md',
  path: 'C:\\runtime\\SOUL.md',
  kind: 'identity',
  checksum: 'soul-checksum',
});
const skill = resource({
  id: 'file:skill',
  name: 'skills/research/SKILL.md',
  path: 'C:\\runtime\\skills\\research\\SKILL.md',
  kind: 'skill',
  checksum: 'skill-checksum',
});
const secret = resource({
  id: 'file:secret',
  name: '.env',
  path: 'C:\\runtime\\.env',
  kind: 'secret_reference',
  editable: false,
  sensitive: true,
  format: 'opaque',
  checksum: undefined,
});

describe('<RuntimeNativePanel />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders real runtime resources and saves with a checksum (Instructions tab)', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });

      if (url === '/v1/agents/a1/runtime') return jsonResponse({ runtime });
      if (url === '/v1/agents/a1/runtime/resources') {
        return jsonResponse({ resources: [overlay, soul, skill, secret] });
      }
      if (url === '/v1/agents/a1/runtime/sessions' && method === 'GET') {
        return jsonResponse({
          sessions: [{
            id: 'session-1',
            sessionKey: 'conv-1',
            runtimeSessionId: 'hermes-session-1',
            status: 'idle',
            selectedModel: 'stepfun/model',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          }],
        });
      }
      if (url === '/v1/agents/a1/runtime/effective-context') {
        return jsonResponse({ layers: [{ precedence: 1, resource: overlay }, { precedence: 2, resource: soul }] });
      }
      if (url === '/v1/agents/a1/runtime/resources/agentis%3Aoverlay') {
        return jsonResponse({ resource: overlay, content: '# Agentis overlay' });
      }
      if (url === '/v1/agents/a1/runtime/resources/file%3Asoul' && method === 'GET') {
        return jsonResponse({ resource: soul, content: '# Native soul' });
      }
      if (url === '/v1/agents/a1/runtime/resources/file%3Asoul' && method === 'PUT') {
        return jsonResponse({
          resource: { ...soul, checksum: 'new-soul-checksum' },
          content: '# Updated native soul',
        });
      }
      if (url === '/v1/agents/a1/runtime/sessions/conv-1' && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({});
    }));

    // The resource/files browser + editor live in the Instructions tab
    // (mode="resources"); the Runtime overview no longer duplicates them.
    render(
      <ToastProvider>
        <RuntimeNativePanel agentId="a1" mode="resources" />
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.getByText('4 discovered resources')).toBeInTheDocument());
    expect(screen.getAllByText('SOUL.md').length).toBeGreaterThan(0);
    expect(screen.getByText('skills/research/SKILL.md')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^SOUL\.md/i }));
    const editor = await screen.findByDisplayValue('# Native soul');
    await userEvent.clear(editor);
    await userEvent.type(editor, '# Updated native soul');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const saveCall = calls.find((call) => call.url.endsWith('/file%3Asoul') && call.method === 'PUT');
      expect(saveCall).toBeDefined();
      expect(JSON.parse(saveCall!.body!)).toEqual({
        content: '# Updated native soul',
        expectedChecksum: 'soul-checksum',
      });
    });
  });
});

const runtime: RuntimeDescriptor = {
  adapterType: 'hermes_agent',
  displayName: 'Hermes Agent',
  binary: value('hermes', 'fallback', false),
  home: value('C:\\runtime', 'profile', true),
  profile: value('default', 'profile', true),
  provider: value('hermes_agent', 'runtime', true),
  currentModel: value('stepfun/model', 'profile', true),
  models: [{ id: 'stepfun/model', label: 'stepfun/model', source: 'profile', verified: true }],
  health: { isHealthy: true, checkedAt: new Date().toISOString(), latencyMs: 12 },
  capabilities: { interactiveChat: true, toolCalling: true, toolForwarding: 'mcp_native' },
  process: { warm: true, generation: 1, activeSessions: 1 },
  resourceCount: 4,
  probedAt: new Date().toISOString(),
};

function resource(
  overrides: Partial<RuntimeResourceDescriptor> & Pick<RuntimeResourceDescriptor, 'id' | 'name' | 'kind'>,
): RuntimeResourceDescriptor {
  return {
    scope: 'profile',
    origin: 'user',
    editable: true,
    sensitive: false,
    format: 'markdown',
    loadPolicy: 'turn',
    reloadPolicy: 'automatic',
    sizeBytes: 12,
    effective: true,
    ...overrides,
  };
}

function value<T>(
  raw: T,
  source: 'runtime' | 'profile' | 'agent_config' | 'workspace_policy' | 'fallback',
  verified: boolean,
) {
  return { value: raw, source, verified, observedAt: new Date().toISOString() };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
