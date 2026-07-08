/**
 * Durable listener cursor — EXTENSIONS-AND-LISTENER-10X §1.3.
 *
 * A persistent listener must remember where it left off across process
 * restarts. The run-scoped scratchpad is disposed when a run ends, so it cannot
 * hold this. We persist into the workflow-scoped `workflow_kv_entries` table
 * (WorkflowStoreService), namespaced per trigger so two listeners on the same
 * workflow never collide.
 */

import type { CursorConfig } from '@agentis/core';
import type { WorkflowStoreService } from '../../services/workflow/workflowStore.js';
import { getPath } from './jsonpath.js';

const CURSOR_NAMESPACE = '__listener_cursor__';

function cursorKey(triggerId: string, scratchpadKey: string): string {
  return `${CURSOR_NAMESPACE}:${triggerId}:${scratchpadKey}`;
}

export class ListenerCursor {
  constructor(
    private readonly store: WorkflowStoreService,
    private readonly args: {
      workspaceId: string;
      workflowId: string;
      triggerId: string;
      config: CursorConfig;
    },
  ) {}

  /** Current cursor value — falls back to the configured initial value. */
  read(): unknown {
    const stored = this.store.get(
      this.args.workspaceId,
      this.args.workflowId,
      cursorKey(this.args.triggerId, this.args.config.scratchpadKey),
    );
    return stored ?? this.args.config.initialValue;
  }

  /** Persist an explicit cursor value. */
  write(value: unknown): void {
    this.store.set(
      this.args.workspaceId,
      this.args.workflowId,
      cursorKey(this.args.triggerId, this.args.config.scratchpadKey),
      value ?? null,
    );
  }

  /** Extract the cursor value from a received event and persist it if present. */
  advanceFrom(event: Record<string, unknown>): void {
    const next = getPath(event, this.args.config.extractPath);
    if (next !== undefined) this.write(next);
  }
}
