import { describe, expect, it, vi } from 'vitest';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe('AdapterManager interactive leases', () => {
  it('serializes equal-priority model loops and releases idempotently', () => {
    const manager = new AdapterManager(logger);
    const release = manager.tryAcquireInteractiveLease('agent-1', {
      ownerId: 'chat-1', kind: 'operator_chat', priority: 100,
    });
    expect(release).toBeTypeOf('function');
    expect(manager.tryAcquireInteractiveLease('agent-1', {
      ownerId: 'chat-2', kind: 'operator_chat', priority: 100,
    })).toBeNull();

    release?.();
    release?.();
    expect(manager.interactiveLease('agent-1')).toBeNull();
  });

  it('lets operator chat preempt a background self-heal without stale release races', () => {
    const manager = new AdapterManager(logger);
    const preempt = vi.fn();
    const releaseHeal = manager.tryAcquireInteractiveLease('agent-1', {
      ownerId: 'heal-1', kind: 'self_heal', priority: 10, onPreempt: preempt,
    });
    const releaseChat = manager.tryAcquireInteractiveLease('agent-1', {
      ownerId: 'chat-1', kind: 'operator_chat', priority: 100,
    });

    expect(preempt).toHaveBeenCalledOnce();
    expect(manager.interactiveLease('agent-1')).toMatchObject({ ownerId: 'chat-1', kind: 'operator_chat' });
    releaseHeal?.();
    expect(manager.interactiveLease('agent-1')).toMatchObject({ ownerId: 'chat-1' });
    releaseChat?.();
    expect(manager.interactiveLease('agent-1')).toBeNull();
  });
});
