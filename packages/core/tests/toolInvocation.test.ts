import { describe, expect, it } from 'vitest';
import { normalizeToolInvocation } from '../src/toolInvocation.js';

describe('normalizeToolInvocation', () => {
  it('unwraps agentis.tools.call into the requested operation', () => {
    expect(normalizeToolInvocation('agentis.tools.call', {
      name: 'agentis.workflow.patch_graph',
      arguments: { workflowId: 'wf-1', token: 'secret' },
    })).toEqual({
      tool: 'agentis.workflow.patch_graph',
      gatewayTool: 'agentis.tools.call',
      input: { workflowId: 'wf-1', token: 'secret' },
    });
  });

  it('leaves direct calls unchanged', () => {
    expect(normalizeToolInvocation('agentis.app.inspect', { appId: 'app-1' }))
      .toEqual({ tool: 'agentis.app.inspect', input: { appId: 'app-1' } });
  });
});
