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

  it('surfaces a resolved open App and its workflows so "this workflow" binds to a concrete id', () => {
    const viewport = {
      surface: 'app_detail' as const,
      resourceKind: 'app' as const,
      resourceId: 'app-9',
      metadata: {
        appId: 'app-9',
        appName: 'AI News Email Digest',
        workflows: [
          { id: 'wf-rank', title: 'Rank and write AI digest' },
          { id: 'wf-send', title: 'Send the digest email' },
        ],
      },
    };
    const prompt = buildOrchestratorSystemPrompt({ context: { ...baseContext, viewport }, viewport });
    expect(prompt).toContain('VIEWPORT CONTEXT');
    expect(prompt).toContain('openApp="AI News Email Digest"');
    expect(prompt).toContain('Workflows in this App');
    expect(prompt).toContain('"Rank and write AI digest" (id=wf-rank)');
    expect(prompt).toContain('"Send the digest email" (id=wf-send)');
  });

  it('calls out a single-workflow App as unambiguously "this workflow"', () => {
    const viewport = {
      surface: 'app_detail' as const,
      resourceKind: 'app' as const,
      resourceId: 'app-1',
      metadata: { appId: 'app-1', appName: 'Solo App', workflows: [{ id: 'wf-1', title: 'The only flow' }], workflowId: 'wf-1' },
    };
    const prompt = buildOrchestratorSystemPrompt({ context: { ...baseContext, viewport }, viewport });
    expect(prompt).toContain('This App has one workflow');
    expect(prompt).toContain('"The only flow" (id=wf-1)');
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

  it('uses the authoritative identity block once instead of duplicating instructions', () => {
    const identityBlock = [
      '<agentis_identity authoritative="true">',
      'name: hermes',
      'role: manager',
      'config: {"cwd":"C:/repo","secret":"[redacted]"}',
      'instructions:',
      'You are Department Manager. ESCALATION RULES: request approval before budget changes.',
      '</agentis_identity>',
    ].join('\n');

    const prompt = buildOrchestratorSystemPrompt({
      context: baseContext,
      workspaceName: 'Personal',
      agentName: 'hermes',
      agentRole: 'manager',
      agentDomain: 'General',
      agentInstructions: 'You are Department Manager. ESCALATION RULES: request approval before budget changes.',
      agentIdentity: identityBlock,
    });

    expect(prompt).not.toContain('You are the Agentis platform orchestrator');
    expect(prompt.startsWith('You are hermes, a manager agent for the "General" domain')).toBe(true);
    expect(prompt).toContain(identityBlock);
    expect(prompt.match(/<agentis_identity/g)).toHaveLength(1);
    expect(prompt).not.toContain('YOUR OPERATING INSTRUCTIONS');
    expect(prompt).not.toContain('AGENT OPERATING INSTRUCTIONS');
    const idx = prompt.indexOf('ESCALATION RULES');
    expect(idx).toBeGreaterThan(-1);
    expect(prompt.lastIndexOf('ESCALATION RULES')).toBe(idx);
  });

  it('legacy null-role agents become generic non-orchestrator Agentis agents', () => {
    const prompt = buildOrchestratorSystemPrompt({
      context: baseContext,
      workspaceName: 'Personal',
      agentName: 'Legacy Specialist',
      agentRole: null,
      agentIdentity: [
        '<agentis_identity authoritative="true">',
        'name: Legacy Specialist',
        'role: agent',
        'instructions:',
        'Answer as the persisted specialist.',
        '</agentis_identity>',
      ].join('\n'),
    });

    expect(prompt).not.toContain('You are the Agentis platform orchestrator');
    expect(prompt.startsWith('You are Legacy Specialist, an Agentis agent working inside the Agentis workspace "Personal".')).toBe(true);
    expect(prompt).toContain('You are NOT the platform orchestrator');
    expect(prompt).toContain('role: agent');
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
