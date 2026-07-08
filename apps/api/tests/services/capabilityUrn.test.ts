import { describe, expect, it } from 'vitest';
import {
  parseCapabilityUrn,
  isCapabilityUrn,
  appUrn,
  workflowUrn,
  nodeUrn,
  phaseUrn,
  agentUrn,
  mcpToolUrn,
  mcpBridgeIdFromUrn,
  collectionUrn,
} from '../../src/services/capability/capabilityUrn.js';

describe('capabilityUrn', () => {
  it('parses an app urn', () => {
    const u = parseCapabilityUrn('app:app_123');
    expect(u.kind).toBe('app');
    expect(u.appId).toBe('app_123');
  });

  it('parses an app-owned workflow urn', () => {
    const u = parseCapabilityUrn('app:app_123/wf:wf_9');
    expect(u.kind).toBe('workflow');
    expect(u.appId).toBe('app_123');
    expect(u.workflowId).toBe('wf_9');
  });

  it('parses a bare workflow urn', () => {
    const u = parseCapabilityUrn('wf:wf_9');
    expect(u.kind).toBe('workflow');
    expect(u.appId).toBeUndefined();
    expect(u.workflowId).toBe('wf_9');
  });

  it('parses a deep node urn under an app', () => {
    const u = parseCapabilityUrn('app:app_1/wf:wf_2/node:qualify');
    expect(u.kind).toBe('node');
    expect(u.appId).toBe('app_1');
    expect(u.workflowId).toBe('wf_2');
    expect(u.nodeId).toBe('qualify');
  });

  it('parses a phase urn', () => {
    const u = parseCapabilityUrn('wf:wf_2/phase:enrichment');
    expect(u.kind).toBe('phase');
    expect(u.workflowId).toBe('wf_2');
    expect(u.phaseId).toBe('enrichment');
  });

  it('parses agent / skill / collection urns', () => {
    expect(parseCapabilityUrn('agent:agent_x').kind).toBe('agent');
    expect(parseCapabilityUrn('agent:agent_x').agentId).toBe('agent_x');
    expect(parseCapabilityUrn('skill:http_fetch').skillId).toBe('http_fetch');
    const coll = parseCapabilityUrn('coll:app_1/leads');
    expect(coll.kind).toBe('collection');
    expect(coll.appId).toBe('app_1');
    expect(coll.collection).toBe('leads');
  });

  it('round-trips an mcp tool id through the urn', () => {
    const urn = mcpToolUrn('mcp__supabase__query');
    expect(urn).toBe('mcp:supabase__query');
    const parsed = parseCapabilityUrn(urn);
    expect(parsed.kind).toBe('mcp_tool');
    expect(mcpBridgeIdFromUrn(parsed)).toBe('mcp__supabase__query');
  });

  it('builders produce parseable canonical forms', () => {
    expect(parseCapabilityUrn(appUrn('a')).kind).toBe('app');
    expect(parseCapabilityUrn(workflowUrn('w')).kind).toBe('workflow');
    expect(parseCapabilityUrn(workflowUrn('w', 'a')).appId).toBe('a');
    expect(parseCapabilityUrn(nodeUrn('w', 'n', 'a')).nodeId).toBe('n');
    expect(parseCapabilityUrn(phaseUrn('w', 'p')).phaseId).toBe('p');
    expect(parseCapabilityUrn(agentUrn('g')).agentId).toBe('g');
    expect(parseCapabilityUrn(collectionUrn('a', 'c')).collection).toBe('c');
  });

  it('rejects malformed urns loudly', () => {
    expect(() => parseCapabilityUrn('')).toThrow();
    expect(() => parseCapabilityUrn('nonsense')).toThrow();
    expect(() => parseCapabilityUrn('app:')).toThrow();
    expect(() => parseCapabilityUrn('app:a/xx:b')).toThrow();
    expect(() => parseCapabilityUrn('wf:w/node:n/extra:z')).toThrow();
    expect(isCapabilityUrn('agent:ok')).toBe(true);
    expect(isCapabilityUrn('???')).toBe(false);
  });
});
