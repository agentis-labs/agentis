/**
 * OpenClawAdapter — current-contract tests.
 *
 * The adapter was rewritten from an ad-hoc gateway WebSocket dialect to
 * OpenClaw's official ACP CLI bridge (`openclaw acp`, spawned lazily per turn).
 * The old tests here drove a FakeWebSocket the adapter no longer opens — they
 * asserted a deleted protocol. These tests pin the adapter's STABLE surface
 * (capabilities, lazy connect, clean dispose) without spawning the binary; a
 * full ACP stream test belongs with an AcpClient fake if/when one exists.
 */
import { describe, it, expect, vi } from 'vitest';
import { OpenClawAdapter } from '../../src/adapters/OpenClawAdapter.js';
import type { Logger } from '../../src/logger.js';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

describe('OpenClawAdapter chat', () => {
  it('advertises interactive chat (not task-only)', () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: 'wss://gw.test', logger });
    expect(adapter.capabilities().interactiveChat).toBe(true);
  });

  it('owns its remote tool loop: session_event forwarding, no local tool calling', () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: 'wss://gw.test', logger });
    const caps = adapter.capabilities();
    expect(caps.toolCalling).toBe(false);
    expect(caps.toolForwarding).toBe('session_event');
  });

  it('connects lazily (no bridge process, no socket) and disposes cleanly', async () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: 'wss://gw.test', logger, defaultSessionId: 'sess-1' });
    // The ACP child starts per turn — connect() must be a cheap no-op that
    // never throws and never requires the binary to be installed.
    await expect(adapter.connect()).resolves.toBeUndefined();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it('reports unhealthy with a clear error when gatewayUrl is missing', async () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: '', logger });
    const health = await adapter.healthCheck();
    expect(health.isHealthy).toBe(false);
    expect(health.error).toMatch(/gatewayUrl/i);
  });
});
