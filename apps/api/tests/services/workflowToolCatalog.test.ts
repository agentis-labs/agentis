/**
 * Workflows-as-agent-tools — dynamic chat tool catalog.
 *
 * Verifies that reusable workflows surface as discrete `workflow.<id>` tools
 * with parameters derived from their inputContract, and that the static
 * catalog is always included as the base.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkspaceToolCatalog, CHAT_TOOL_CATALOG } from '../../src/services/chatToolCatalog.js';

describe('buildWorkspaceToolCatalog', () => {
  it('includes the static catalog plus one tool per workflow', () => {
    const catalog = buildWorkspaceToolCatalog([
      { id: 'wf-1', title: 'Daily Digest', summary: 'Summarize the inbox' },
      { id: 'wf-2', title: 'Lead Scorer' },
    ]);
    expect(catalog.length).toBe(CHAT_TOOL_CATALOG.length + 2);
    const names = catalog.map((t) => t.name);
    expect(names).toContain('workflow.wf-1');
    expect(names).toContain('workflow.wf-2');
    // Static tools still present.
    expect(names).toContain('agentis.workflow.run');
  });

  it('derives typed parameters from the inputContract', () => {
    const catalog = buildWorkspaceToolCatalog([
      {
        id: 'wf-typed',
        title: 'Typed Flow',
        inputContract: {
          fields: [
            { key: 'email', type: 'string', required: true, description: 'Recipient' },
            { key: 'count', type: 'number' },
            { key: 'urgent', type: 'boolean', required: true },
          ],
        },
      },
    ]);
    const tool = catalog.find((t) => t.name === 'workflow.wf-typed')!;
    expect(tool).toBeDefined();
    const props = tool.parameters.properties as Record<string, { type: string; description?: string }>;
    expect(props.email).toEqual({ type: 'string', description: 'Recipient' });
    expect(props.count).toEqual({ type: 'number' });
    expect(props.urgent).toEqual({ type: 'boolean' });
    expect(tool.parameters.required).toEqual(['email', 'urgent']);
  });

  it('falls back to a free-form inputs object when no contract is declared', () => {
    const catalog = buildWorkspaceToolCatalog([{ id: 'wf-bare', title: 'Bare' }]);
    const tool = catalog.find((t) => t.name === 'workflow.wf-bare')!;
    const props = tool.parameters.properties as Record<string, { type: string }>;
    expect(props.inputs).toEqual({ type: 'object', description: 'Free-form inputs for the workflow trigger.' });
    expect(tool.parameters.required).toBeUndefined();
  });

  it('embeds the workflow title and summary in the description', () => {
    const catalog = buildWorkspaceToolCatalog([
      { id: 'wf-desc', title: 'Weekly Report', summary: 'Compiles metrics' },
    ]);
    const tool = catalog.find((t) => t.name === 'workflow.wf-desc')!;
    expect(tool.description).toContain('Weekly Report');
    expect(tool.description).toContain('Compiles metrics');
  });
});
