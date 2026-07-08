import type { Logger } from '../logger.js';
import type { AgentMemoryService } from './agent/agentMemory.js';

export class FailureReflectionService {
  constructor(
    private readonly memory: AgentMemoryService,
    private readonly logger: Logger,
  ) {}

  reflect(args: {
    workspaceId: string;
    agentId: string;
    runId: string;
    nodeTitle: string;
    prompt?: string;
    error: string;
  }): void {
    try {
      const error = compact(args.error, 360);
      const task = compact(args.prompt ?? args.nodeTitle, 180);
      this.memory.append({
        workspaceId: args.workspaceId,
        agentId: args.agentId,
        section: 'Failure lessons',
        tags: ['failure', 'reflection', `run:${args.runId}`],
        content: `Failure lesson from "${args.nodeTitle}": while attempting ${task}, the task failed with "${error}". Before retrying, verify assumptions and inputs implicated by this error, then use a smaller validation step.`,
      });
    } catch (error) {
      this.logger.warn('failure_reflection.persist_failed', {
        runId: args.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function compact(value: string, length: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, length);
}
