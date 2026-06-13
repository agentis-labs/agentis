/**
 * Channel-shaped orchestrator prompt (OMNICHANNEL §4.3) — pure function.
 */

import { describe, expect, it } from 'vitest';
import {
  buildOrchestratorSystemPrompt,
  responseProfileForChannel,
} from '../../src/services/orchestratorPrompt.js';

const baseContext = {
  workspaceId: 'ws1',
  ambientId: null,
  agentId: 'a1',
  userId: 'u1',
  conversationId: 'c1',
  maxTurns: 8,
  viewport: null,
} as const;

describe('channel-shaped orchestrator prompt', () => {
  it('adds CHANNEL CONTEXT, WORKSPACE SITUATION, and a response profile', () => {
    const prompt = buildOrchestratorSystemPrompt({
      context: baseContext,
      channelContext: { kind: 'whatsapp', from: 'Bob', chatId: '555@s.whatsapp.net' },
      situationalModel: 'WORKSPACE SITUATION\nWorkspace: Acme\nAgent roster: ...',
      responseProfile: responseProfileForChannel('whatsapp'),
    });
    expect(prompt).toContain('CHANNEL CONTEXT');
    expect(prompt).toContain('whatsapp channel');
    expect(prompt).toContain('From: Bob');
    expect(prompt).toContain('WORKSPACE SITUATION');
    expect(prompt).toContain('RESPONSE STYLE');
    expect(prompt).toContain('short and conversational');
  });

  it('omits channel blocks for ordinary web turns', () => {
    const prompt = buildOrchestratorSystemPrompt({ context: baseContext });
    expect(prompt).not.toContain('CHANNEL CONTEXT');
    expect(prompt).not.toContain('RESPONSE STYLE');
  });

  it('response profile differs by surface family', () => {
    expect(responseProfileForChannel('telegram')).toContain('short and conversational');
    expect(responseProfileForChannel('slack')).toContain('threaded');
    expect(responseProfileForChannel('discord')).toContain('threaded');
  });
});

describe('role-true identity header', () => {
  it('a non-orchestrator agent leads with its own name, role, domain, and instructions', () => {
    const prompt = buildOrchestratorSystemPrompt({
      context: baseContext,
      workspaceName: 'Personal',
      agentName: 'hermes',
      agentRole: 'manager',
      agentDomain: 'General',
      agentInstructions: 'You are Department Manager. ESCALATION RULES: request approval before budget changes.',
    });
    expect(prompt).not.toContain('You are the Agentis platform orchestrator');
    expect(prompt.startsWith('You are hermes, a manager agent for the "General" domain')).toBe(true);
    expect(prompt).toContain('You are NOT the platform orchestrator');
    // Instructions lead (identity contract), and appear exactly once.
    const idx = prompt.indexOf('ESCALATION RULES');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(prompt.indexOf('CURRENT CONTEXT'));
    expect(prompt.lastIndexOf('ESCALATION RULES')).toBe(idx);
  });

  it('the orchestrator keeps the central-intelligence header and trailing instructions block', () => {
    const prompt = buildOrchestratorSystemPrompt({
      context: baseContext,
      agentRole: 'orchestrator',
      agentInstructions: 'Coordinate everything.',
    });
    expect(prompt).toContain('You are the Agentis platform orchestrator');
    expect(prompt).toContain('AGENT OPERATING INSTRUCTIONS');
  });

  it('mcp_native turns drop the static platform manual and point at live MCP tools', () => {
    const injected = buildOrchestratorSystemPrompt({ context: baseContext });
    const mcpNative = buildOrchestratorSystemPrompt({ context: baseContext, toolSurface: 'mcp_native' });
    expect(injected).toContain('AGENTIS PLATFORM KNOWLEDGE');
    expect(mcpNative).not.toContain('AGENTIS PLATFORM KNOWLEDGE');
    expect(mcpNative).toContain('mounted natively in your runtime');
    // Behavior rules survive in both modes.
    expect(mcpNative).toContain('ACTION-FIRST RULES');
    expect(mcpNative.length).toBeLessThan(injected.length);
  });
});
