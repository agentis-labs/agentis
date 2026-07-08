import { describe, expect, it } from 'vitest';
import {
  mergeWorkflowStageTarget,
  workflowStageTargetFromBuildPayload,
} from '../../src/components/chat/workflowStage';

describe('workflow stage targeting', () => {
  it('creates a stage target from a real workflow build payload', () => {
    expect(workflowStageTargetFromBuildPayload({
      workflowId: 'workflow-1',
      runId: 'run-1',
      agentId: 'agent-1',
    })).toEqual({
      workflowId: 'workflow-1',
      runId: 'run-1',
      agentId: 'agent-1',
    });
  });

  it('ignores payloads that do not identify a workflow', () => {
    expect(workflowStageTargetFromBuildPayload({ runId: 'run-1' })).toBeNull();
    expect(workflowStageTargetFromBuildPayload(null)).toBeNull();
  });

  it('preserves known run context while later phases update the same stage', () => {
    expect(mergeWorkflowStageTarget(
      { workflowId: 'workflow-1', runId: 'run-1', agentId: 'agent-1' },
      { workflowId: 'workflow-1' },
    )).toEqual({
      workflowId: 'workflow-1',
      runId: 'run-1',
      agentId: 'agent-1',
    });
  });
});
