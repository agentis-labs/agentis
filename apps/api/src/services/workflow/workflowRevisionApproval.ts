import { AgentisError } from '@agentis/core';
import type { ApprovalInboxService } from '../approvalInbox.js';
import type { WorkflowRevisionService } from './workflowRevisionService.js';

/**
 * Connect Approval Inbox decisions to the immutable revision lifecycle.
 * The reviewed hash and active base are both checked again at resolution time,
 * so an old approval can never activate different or stale graph bytes.
 */
export function bindWorkflowRevisionApproval(args: {
  approvals: ApprovalInboxService;
  revisions: WorkflowRevisionService;
}): void {
  args.approvals.bindWorkflowRevisionHandler(async ({ decision, payload, resolvedByUserId }) => {
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : '';
    const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : '';
    const revisionId = typeof payload.revisionId === 'string' ? payload.revisionId : '';
    const expectedActiveRevisionId = typeof payload.expectedActiveRevisionId === 'string'
      ? payload.expectedActiveRevisionId
      : '';
    const expectedSemanticHash = typeof payload.semanticHash === 'string' ? payload.semanticHash : '';
    if (!workspaceId || !workflowId || !revisionId || !expectedActiveRevisionId || !resolvedByUserId) {
      throw new AgentisError('VALIDATION_FAILED', 'Revision approval payload is incomplete.');
    }
    const revision = args.revisions.revision(workspaceId, workflowId, revisionId);
    if (!revision || revision.semanticHash !== expectedSemanticHash) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'The approved workflow candidate no longer matches the reviewed hash.');
    }
    if (decision === 'reject') {
      args.revisions.abandon({
        workspaceId,
        workflowId,
        revisionId,
        actor: { type: 'user', id: resolvedByUserId },
        reason: 'Rejected through the Approval Inbox',
      });
      return;
    }
    const promotion = {
      workspaceId,
      workflowId,
      revisionId,
      expectedActiveRevisionId,
      actor: { type: 'user', id: resolvedByUserId },
      operatorApproval: true,
    } as const;
    if (payload.publicationAuthority === 'app_delivery' && typeof payload.deliveryRunId === 'string') {
      args.revisions.promoteFromAppDelivery({ ...promotion, deliveryRunId: payload.deliveryRunId });
    } else {
      args.revisions.promote(promotion);
    }
  });
}
