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
 * uses the harness text; reasoning shows the agent's ACTUAL thinking (scrubbed +
 * clipped) so the operator sees real work — like Codex — instead of a canned
 * phase. Set `AGENTIS_REDACT_REASONING=1` to fall back to the old summary (e.g.
 * for a shared/multi-tenant surface where chain-of-thought must stay private).
 */
export function runtimeProgressActivity(options: RuntimeProgressOptions): RuntimeActivity {
  return {
    type: 'activity',
    id: options.id,
    phase: 'runtime',
    status: 'running',
    label: options.reasoning
      ? reasoningLabel(options.text, options.runtimeName)
      : options.text
        ? compactRuntimeProgressLabel(options.text)
        : `${options.runtimeName} is working`,
    startedAt: new Date().toISOString(),
    ...(options.agentId ? { agentId: options.agentId } : {}),
  };
}

/** Whether to redact chain-of-thought to a high-level phase (off by default). */
function shouldRedactReasoning(): boolean {
  const value = process.env.AGENTIS_REDACT_REASONING;
  return value === '1' || value?.toLowerCase() === 'true';
}

/**
 * Operator-facing reasoning label: the real thought, secrets scrubbed and clipped
 * to one line. Falls back to the summarized phase when redaction is enabled or
 * there is no text.
 */
function reasoningLabel(text: string | undefined, runtimeName: string): string {
  const real = text?.replace(/\s+/g, ' ').trim();
  if (!real) return `${runtimeName} is reasoning`;
  if (shouldRedactReasoning()) return summarizeRuntimeReasoning(text, runtimeName);
  return clipRuntimeLabel(scrubSecrets(real));
}

/**
 * A compact, operator-facing label for a harness's OWN tool/command use, showing
 * the tool AND its key input — the legibility Codex gives ("Running npm test") but
 * for every runtime: "Using Bash: ls -la", "Using ToolSearch: auth flow",
 * "Used build_workflow". Secrets are scrubbed; the input is clipped to one line.
 */
export function toolActivityLabel(verb: 'Using' | 'Used' | 'Failed', name: unknown, input?: unknown): string {
  const tool = prettyToolName(name);
  const detail = compactToolInput(input);
  return detail ? `${verb} ${tool}: ${detail}` : `${verb} ${tool}`;
}

/** Normalize a tool name for display: drop the `mcp__server__` prefix, de-snake. */
export function prettyToolName(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return 'a tool';
  return value.replace(/^mcp__[^_]+__/, '').replace(/[._]/g, ' ').trim() || 'a tool';
}

/** The most meaningful one-line summary of a tool call's input. */
function compactToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return clipRuntimeLabel(scrubSecrets(input), 140);
  if (typeof input !== 'object') return clipRuntimeLabel(String(input), 140);
  const obj = input as Record<string, unknown>;
  const primary = obj.command ?? obj.cmd ?? obj.query ?? obj.q ?? obj.url ?? obj.path
    ?? obj.file ?? obj.file_path ?? obj.filePath ?? obj.pattern ?? obj.prompt ?? obj.text ?? obj.description;
  if (typeof primary === 'string' && primary.trim()) return clipRuntimeLabel(scrubSecrets(primary), 140);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value == null || typeof value === 'object') continue;
    parts.push(`${key}=${clipRuntimeLabel(scrubSecrets(String(value)), 40)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(', ');
}

/** Redact obvious secrets so live reasoning/tool labels never leak credentials. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh_***')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, 'jwt-***')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]{12,}/gi, '$1 ***')
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi, '$1=***');
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
