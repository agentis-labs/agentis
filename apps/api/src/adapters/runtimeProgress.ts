import type { ChatDelta } from '@agentis/core';

type RuntimeActivity = Extract<ChatDelta, { type: 'activity' }>;

export interface RuntimeProgressOptions {
  id: string;
  runtimeName: string;
  text?: string;
  reasoning?: boolean;
  agentId?: string;
}

/**
 * Build one stable, replace-in-place runtime activity row. Visible narration
 * can use the harness text; private reasoning is reduced to a high-level phase.
 */
export function runtimeProgressActivity(options: RuntimeProgressOptions): RuntimeActivity {
  return {
    type: 'activity',
    id: options.id,
    phase: 'runtime',
    status: 'running',
    label: options.reasoning
      ? summarizeRuntimeReasoning(options.text, options.runtimeName)
      : options.text
        ? compactRuntimeProgressLabel(options.text)
        : `${options.runtimeName} is working`,
    startedAt: new Date().toISOString(),
    ...(options.agentId ? { agentId: options.agentId } : {}),
  };
}

/**
 * Keep enough content for wide/fullscreen chat. The frontend owns visual
 * truncation, so docked mode clips naturally while fullscreen reveals more.
 */
export function compactRuntimeProgressLabel(value: string): string {
  const text = value
    .replace(/AGENTIS_TOOL_CALL[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'Working';
  const first = text.split(/(?<=[.!?])\s+/)[0]!.replace(/[.!?]+$/, '');
  const withoutLead = first.replace(/^(?:I['’]?ll|I will|I['’]?m going to|I am going to|Let me)\s+/i, '');
  const match = withoutLead.match(/^([a-z]+)\b(.*)$/i);
  const gerunds: Record<string, string> = {
    analyze: 'Analyzing',
    check: 'Checking',
    continue: 'Continuing',
    correct: 'Correcting',
    fix: 'Fixing',
    inspect: 'Inspecting',
    investigate: 'Investigating',
    look: 'Reviewing',
    read: 'Reading',
    review: 'Reviewing',
    run: 'Running',
    search: 'Searching',
    test: 'Testing',
    trace: 'Tracing',
    update: 'Updating',
    verify: 'Verifying',
  };
  const normalized = match && gerunds[match[1]!.toLowerCase()]
    ? `${gerunds[match[1]!.toLowerCase()]}${match[2]}`
    : withoutLead;
  return clipRuntimeLabel(normalized);
}

/**
 * Never expose raw chain-of-thought. Classify it into an operator-useful phase
 * using a deliberately small vocabulary.
 */
export function summarizeRuntimeReasoning(value: string | undefined, runtimeName: string): string {
  const text = value?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
  if (/\b(read|inspect|review|scan|look)\b/.test(text) && /\b(file|repo|repository|workspace|context|code)\b/.test(text)) {
    return 'Reviewing workspace context';
  }
  if (/\b(search|find|lookup|look up|research)\b/.test(text)) return 'Searching for relevant information';
  if (/\b(test|verify|validate|check)\b/.test(text)) return 'Checking the result';
  if (/\b(plan|approach|strategy|steps?)\b/.test(text)) return 'Planning the next step';
  if (/\b(tool|command|execute|run)\b/.test(text)) return 'Preparing a runtime action';
  if (/\b(answer|respond|reply|summar)\b/.test(text)) return 'Preparing the response';
  return `${runtimeName} is reasoning`;
}

export function clipRuntimeLabel(value: string, max = 320): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
