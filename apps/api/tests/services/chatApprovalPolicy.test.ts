import { describe, expect, it } from 'vitest';
import type { AgentisToolDefinition } from '@agentis/core';
import { decideToolApproval } from '../../src/services/chat/chatApprovalPolicy.js';

function tool(riskLevel: 'low' | 'medium' | 'high' | 'critical', alwaysConfirm = false): AgentisToolDefinition {
  return {
    id: `test.${riskLevel}`,
    family: 'run',
    description: 'test',
    inputSchema: { type: 'object' },
    mutating: true,
    approval: { riskLevel, alwaysConfirm },
  };
}

describe('graduated Ask approval policy', () => {
  it('lets balanced Ask run low/medium work and escalates high/critical work', () => {
    expect(decideToolApproval({ name: 'x', definition: tool('low'), permissionMode: 'ask' }).requiresApproval).toBe(false);
    expect(decideToolApproval({ name: 'x', definition: tool('medium'), permissionMode: 'ask' }).requiresApproval).toBe(false);
    expect(decideToolApproval({ name: 'x', definition: tool('high'), permissionMode: 'ask' }).requiresApproval).toBe(true);
    expect(decideToolApproval({ name: 'x', definition: tool('critical'), permissionMode: 'ask' }).requiresApproval).toBe(true);
  });

  it('supports more and less cautious conversation preferences', () => {
    expect(decideToolApproval({ name: 'x', definition: tool('medium'), permissionMode: 'ask', sensitivity: 'cautious' }).requiresApproval).toBe(true);
    expect(decideToolApproval({ name: 'x', definition: tool('high'), permissionMode: 'ask', sensitivity: 'autonomous' }).requiresApproval).toBe(false);
    expect(decideToolApproval({ name: 'x', definition: tool('critical'), permissionMode: 'ask', sensitivity: 'autonomous' }).requiresApproval).toBe(true);
  });

  it('never blocks reads and keeps protected actions gated in Ask', () => {
    const read: AgentisToolDefinition = {
      id: 'test.read', family: 'inspect', description: 'read', inputSchema: { type: 'object' }, mutating: false,
    };
    expect(decideToolApproval({ name: read.id, definition: read, permissionMode: 'ask', sensitivity: 'cautious' }).requiresApproval).toBe(false);
    expect(decideToolApproval({ name: 'x', definition: tool('medium', true), permissionMode: 'ask', sensitivity: 'autonomous' }).requiresApproval).toBe(true);
  });

  it('keeps ordinary legacy workspace mutations autonomous in balanced Ask', () => {
    const legacy: AgentisToolDefinition = {
      id: 'test.legacy', family: 'run', description: 'legacy', inputSchema: { type: 'object' }, mutating: true,
    };
    const decision = decideToolApproval({ name: legacy.id, definition: legacy, permissionMode: 'ask' });
    expect(decision.riskLevel).toBe('medium');
    expect(decision.requiresApproval).toBe(false);
  });

  it('keeps destructive and security-sensitive legacy operations protected', () => {
    const legacy: AgentisToolDefinition = {
      id: 'agentis.data.delete', family: 'run', description: 'delete', inputSchema: { type: 'object' }, mutating: true,
    };
    expect(decideToolApproval({ name: legacy.id, definition: legacy, permissionMode: 'ask' }).requiresApproval).toBe(true);
    expect(decideToolApproval({ name: 'agentis.connection.grant', definition: { ...legacy, id: 'agentis.connection.grant' }, permissionMode: 'ask', sensitivity: 'autonomous' }).requiresApproval).toBe(true);
  });
});
