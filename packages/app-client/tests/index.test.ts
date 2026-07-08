import { describe, expect, it, vi } from 'vitest';
import { createInProcessAppClient } from '../src/index';

describe('@agentis/app-client', () => {
  it('queries data and invokes actions through the in-process transport', async () => {
    const invokeAction = vi.fn(async () => ({ ok: true }));
    const client = createInProcessAppClient({
      appId: 'app_1',
      surface: 'home',
      query: async (collection, query) => [{ id: 'row_1', collection, query }],
      invokeAction,
      getState: () => undefined,
      setState: () => undefined,
      navigate: () => undefined,
    });

    await expect(client.data.query('tasks', { limit: 10 })).resolves.toEqual([
      { id: 'row_1', collection: 'tasks', query: { limit: 10 } },
    ]);
    await expect(client.actions.invoke('complete', { id: 'row_1' })).resolves.toEqual({ ok: true });
    expect(invokeAction).toHaveBeenCalledWith('complete', { id: 'row_1' });
  });

  it('keeps local UI state observable', async () => {
    const state: Record<string, unknown> = {};
    const client = createInProcessAppClient({
      appId: 'app_1',
      surface: 'home',
      query: async () => [],
      invokeAction: async () => undefined,
      getState: (key) => (key ? state[key] : state),
      setState: (key, value) => {
        state[key] = value;
      },
      navigate: () => undefined,
    });
    const seen: unknown[] = [];
    const off = client.state.subscribe('filter', (value) => seen.push(value));

    await client.state.set('filter', 'open');

    expect(await client.state.get('filter')).toBe('open');
    expect(seen).toEqual(['open']);
    off();
  });

  it('routes navigation requests through the runtime', async () => {
    const navigate = vi.fn();
    const client = createInProcessAppClient({
      appId: 'app_1',
      surface: 'home',
      query: async () => [],
      invokeAction: async () => undefined,
      getState: () => undefined,
      setState: () => undefined,
      navigate,
    });

    await client.navigation.go('settings', { tab: 'data' });

    expect(navigate).toHaveBeenCalledWith('settings', { tab: 'data' });
  });
});
