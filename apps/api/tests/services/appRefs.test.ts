/**
 * appRefs — the single source of truth for entity references in a workflow graph.
 *
 * This exists because discovery (export) and rebinding (install) were two
 * hand-maintained lists that drifted: only `subflow`/`loop` were covered, so
 * `converge`/`pursue`/`error_trigger`/listener body workflows never travelled with
 * an App, and `data_query.appId` was never rebound — the App imported pointing at
 * the EXPORTER's app id and silently read an empty collection. Both failures look
 * like a successful import, because a stale id is still a valid-looking UUID.
 *
 * So these tests assert on the FULL ref set, not on "it found some refs".
 */
import { describe, it, expect } from 'vitest';
import { walkNodeRefs, referencedIds, rewriteNodeRefs, type RefIdMap } from '@agentis/app';

/** A graph exercising every referencing node kind we support. */
function kitchenSinkGraph() {
  const node = (id: string, config: Record<string, unknown>) => ({ id, type: 'task', position: { x: 0, y: 0 }, config });
  return {
    version: 1,
    edges: [],
    nodes: [
      node('n_sub', { kind: 'subflow', workflowId: 'wf-sub', inputMapping: {}, outputMapping: {} }),
      node('n_loop', { kind: 'loop', bodyWorkflowId: 'wf-loop', itemsExpression: '{{x}}', maxConcurrency: 1 }),
      node('n_conv', { kind: 'converge', bodyWorkflowId: 'wf-converge' }),
      node('n_pursue', { kind: 'pursue', bodyWorkflowId: 'wf-pursue' }),
      node('n_err', { kind: 'error_trigger', targetWorkflowId: 'wf-err', onStatus: ['FAILED'] }),
      node('n_agent', { kind: 'agent_task', agentId: 'agent-1', agentPackageRef: 'Sales Bot', skills: ['closing'], capabilityTags: [] }),
      node('n_session', { kind: 'agent_session', agentId: 'agent-2' }),
      node('n_ext', { kind: 'extension_task', extensionId: 'ext-1', operationName: 'run', inputMapping: {}, outputMapping: {} }),
      node('n_kb', { kind: 'knowledge', knowledgeBaseId: 'kb-1' }),
      node('n_seed', { kind: 'knowledge', knowledgeBaseId: '__seeds' }),
      node('n_query', { kind: 'data_query', appId: 'app-source', collection: 'leads' }),
      node('n_mutate', { kind: 'data_mutate', appId: 'app-source', collection: 'leads', operation: 'insert' }),
      node('n_int', { kind: 'integration', integrationId: 'slack', operationId: 'send', inputs: {}, credentialId: 'cred-1' }),
      node('n_chan', { kind: 'channel', connectionId: 'conn-1' }),
      node('n_http', { kind: 'http_request', url: 'https://x', auth: { type: 'bearer', credentialId: 'cred-2' } }),
      node('n_trigger', {
        kind: 'trigger',
        errorTrigger: { targetWorkflowId: 'wf-trigger-err' },
        listenerConfig: { source: { kind: 'agent_event', agentId: 'agent-3' } },
      }),
      // No entity references — must contribute nothing.
      node('n_code', { kind: 'code', language: 'javascript', source: 'return 1' }),
    ],
  };
}

describe('walkNodeRefs — full reference discovery', () => {
  it('finds EVERY sub-workflow reference, not just subflow/loop (the shipped bug)', () => {
    expect(referencedIds(kitchenSinkGraph(), 'workflow').sort()).toEqual([
      'wf-converge', 'wf-err', 'wf-loop', 'wf-pursue', 'wf-sub', 'wf-trigger-err',
    ]);
  });

  it('finds agents across agent_task, agent_session and listener sources', () => {
    expect(referencedIds(kitchenSinkGraph(), 'agent').sort()).toEqual(['agent-1', 'agent-2', 'agent-3']);
  });

  it('finds the App self-references that were silently never rebound', () => {
    expect(referencedIds(kitchenSinkGraph(), 'app')).toEqual(['app-source']);
  });

  it('finds extensions, knowledge bases, credentials and connections', () => {
    const g = kitchenSinkGraph();
    expect(referencedIds(g, 'extension')).toEqual(['ext-1']);
    expect(referencedIds(g, 'knowledgeBase')).toEqual(['kb-1']); // '__seeds' excluded
    expect(referencedIds(g, 'credential').sort()).toEqual(['cred-1', 'cred-2']);
    expect(referencedIds(g, 'connection')).toEqual(['conn-1']);
  });

  it('treats the __seeds sentinel as a marker, not a dependency to export', () => {
    expect(referencedIds(kitchenSinkGraph(), 'knowledgeBase')).not.toContain('__seeds');
  });

  it('separates name-based refs (connector slug, skills) from copyable ids', () => {
    const refs = walkNodeRefs(kitchenSinkGraph());
    expect(refs.find((r) => r.kind === 'connector')).toMatchObject({ value: 'slack', byName: true });
    expect(refs.find((r) => r.kind === 'skillName')).toMatchObject({ value: 'closing', byName: true });
    // byName refs are excluded from id collection — they resolve against the target.
    expect(referencedIds(kitchenSinkGraph(), 'connector')).toEqual([]);
  });

  it('marks hard dependencies required, and ignores nodes with no references', () => {
    const refs = walkNodeRefs(kitchenSinkGraph());
    expect(refs.find((r) => r.nodeId === 'n_sub')?.required).toBe(true);
    expect(refs.find((r) => r.nodeId === 'n_query')?.required).toBe(true);
    expect(refs.some((r) => r.nodeId === 'n_code')).toBe(false);
  });

  it('is safe on empty/malformed graphs', () => {
    expect(walkNodeRefs(null)).toEqual([]);
    expect(walkNodeRefs({ nodes: 'nope' })).toEqual([]);
    expect(walkNodeRefs({ nodes: [{ id: 'x' }] })).toEqual([]);
  });
});

describe('rewriteNodeRefs — rebinding', () => {
  const idMap: RefIdMap = {
    workflow: new Map([['wf-sub', 'WF-SUB'], ['wf-converge', 'WF-CONV'], ['wf-trigger-err', 'WF-TERR']]),
    agent: new Map([['agent-1', 'AGENT-1'], ['agent-3', 'AGENT-3']]),
    app: new Map([['app-source', 'APP-NEW']]),
  };

  function configOf(graph: unknown, nodeId: string): Record<string, unknown> {
    const nodes = (graph as { nodes: Array<{ id: string; config: Record<string, unknown> }> }).nodes;
    return nodes.find((n) => n.id === nodeId)!.config;
  }

  it('rewrites every mapped reference, including nested trigger paths', () => {
    const out = rewriteNodeRefs(kitchenSinkGraph(), idMap);
    expect(configOf(out, 'n_sub').workflowId).toBe('WF-SUB');
    expect(configOf(out, 'n_conv').bodyWorkflowId).toBe('WF-CONV');
    expect(configOf(out, 'n_agent').agentId).toBe('AGENT-1');
    expect((configOf(out, 'n_trigger').errorTrigger as Record<string, unknown>).targetWorkflowId).toBe('WF-TERR');
    expect(((configOf(out, 'n_trigger').listenerConfig as Record<string, Record<string, unknown>>).source).agentId).toBe('AGENT-3');
  });

  it('rebinds the App self-reference so the imported App reads ITS OWN data', () => {
    const out = rewriteNodeRefs(kitchenSinkGraph(), idMap);
    expect(configOf(out, 'n_query').appId).toBe('APP-NEW');
    expect(configOf(out, 'n_mutate').appId).toBe('APP-NEW');
  });

  it('leaves unmapped references untouched rather than nulling them', () => {
    const out = rewriteNodeRefs(kitchenSinkGraph(), idMap);
    expect(configOf(out, 'n_loop').bodyWorkflowId).toBe('wf-loop'); // not in the map
    expect(configOf(out, 'n_session').agentId).toBe('agent-2');
    expect(configOf(out, 'n_kb').knowledgeBaseId).toBe('kb-1');
  });

  it('does not mutate the input graph', () => {
    const graph = kitchenSinkGraph();
    rewriteNodeRefs(graph, idMap);
    expect(configOf(graph, 'n_sub').workflowId).toBe('wf-sub');
  });

  it('returns the graph unchanged when nothing maps', () => {
    const graph = kitchenSinkGraph();
    expect(rewriteNodeRefs(graph, {})).toBe(graph);
  });
});
