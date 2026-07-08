export type ToolCallStatus = 'running' | 'success' | 'error' | 'paused' | 'stopped';

export interface ToolCallData {
  id: string;
  name: string;
  status: ToolCallStatus;
  durationMs?: number | null;
  args?: unknown;
  result?: unknown;
  error?: string | null;
}



