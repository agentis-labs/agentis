/**
 * markerToolProtocol — tool-calling for CLI runtimes that have no native
 * function-calling channel (Codex CLI, Claude Code CLI).
 *
 * These adapters spawn a child process in `--json` mode and the model is
 * instructed (see `buildMarkerToolPrompt`) to emit tool calls as a marker
 * embedded in its assistant text:
 *
 *   AGENTIS_TOOL_CALL {"name":"agentis.build_workflow","arguments":{...}}
 *   <agentis_tool_call>{"name":"...","arguments":{...}}</agentis_tool_call>
 *
 * This module is the single source of truth for parsing those markers back into
 * structured `ChatToolCall`s and for keeping environment noise out of the
 * operator-visible transcript.
 *
 * Why a dedicated module: the previous per-adapter implementation anchored the
 * marker to the start/end of a line (`/^AGENTIS_TOOL_CALL\s+({.*})\s*$/m`) and,
 * in the `catch` branch, appended every non-JSON stdout line straight into the
 * transcript. On Windows the Codex sandbox prints `taskkill` output
 * ("ÊXITO: o processo com PID … foi finalizado") on the SAME line as the
 * marker. That broke the `\s*$` anchor, so the tool call was never parsed,
 * never executed, never stripped — the raw marker + PID spam was shown to the
 * operator and the platform did nothing. This module fixes both halves:
 *   1. brace-balanced extraction tolerant of trailing prose/junk, and
 *   2. a locale-agnostic noise filter for process-kill chatter.
 */

import type { ToolDefinition } from '@agentis/core';

export interface MarkerToolCall {
  name: string;
  args: unknown;
}

export interface MarkerExtractionResult {
  /** Tool calls discovered in the text, de-duplicated by name+args. */
  calls: MarkerToolCall[];
  /** The operator-visible text with every marker removed. */
  cleaned: string;
}

const MARKER_KEYWORD = 'AGENTIS_TOOL_CALL';

/**
 * Extract every Agentis tool-call marker embedded in CLI output.
 *
 * Robust to: trailing prose after the JSON, junk concatenated on the same line,
 * multi-line JSON, nested braces, and braces inside JSON string values. Markers
 * that don't parse are left in the cleaned text verbatim so nothing is silently
 * swallowed.
 */
export function extractMarkerToolCalls(input: string): MarkerExtractionResult {
  const calls: MarkerToolCall[] = [];
  const seen = new Set<string>();
  const record = (payload: MarkerToolCall | null): boolean => {
    if (!payload) return false;
    const key = `${payload.name}:${stableJson(payload.args)}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push(payload);
    }
    return true;
  };

  // 1) XML-style fenced form: <agentis_tool_call>{...}</agentis_tool_call>
  const withoutXml = input.replace(
    /<agentis_tool_call>\s*([\s\S]*?)\s*<\/agentis_tool_call>/gi,
    (whole, body: string) => (record(parseMarkerPayload(body)) ? '' : whole),
  );

  // 2) Keyword form with brace-balanced JSON extraction.
  let cleaned = '';
  let cursor = 0;
  while (cursor < withoutXml.length) {
    const markerIndex = withoutXml.indexOf(MARKER_KEYWORD, cursor);
    if (markerIndex === -1) {
      cleaned += withoutXml.slice(cursor);
      break;
    }
    cleaned += withoutXml.slice(cursor, markerIndex);

    // Skip whitespace / a colon between the keyword and the opening brace.
    let braceIndex = markerIndex + MARKER_KEYWORD.length;
    while (braceIndex < withoutXml.length && withoutXml[braceIndex] !== '{' && /[\s:]/.test(withoutXml[braceIndex]!)) {
      braceIndex += 1;
    }
    if (withoutXml[braceIndex] !== '{') {
      // Not a real marker (keyword mentioned in prose) — keep it as text.
      cleaned += MARKER_KEYWORD;
      cursor = markerIndex + MARKER_KEYWORD.length;
      continue;
    }

    const end = matchBalancedBrace(withoutXml, braceIndex);
    if (end === -1) {
      // Unterminated JSON — keep the remainder as text and stop.
      cleaned += withoutXml.slice(markerIndex);
      break;
    }
    const parsed = parseMarkerPayload(withoutXml.slice(braceIndex, end));
    if (!record(parsed)) {
      // Failed to parse — preserve the original span so it isn't lost.
      cleaned += withoutXml.slice(markerIndex, end);
    }
    cursor = end;
  }

  return { calls, cleaned: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * True for stdout lines that are environment noise rather than model output.
 *
 * Primarily Windows `taskkill /F /T` output emitted when the Codex sandbox
 * tears down its child process tree. Matched in a locale-agnostic way: a line
 * that references a PID together with a termination verb in any of the locales
 * we've observed. These lines must never reach the operator.
 */
export function isProcessNoiseLine(line: string): boolean {
  const value = line.trim();
  if (!value) return true;
  const mentionsPid = /\bPID\b/i.test(value) || /processo|process|proceso|prozess|processus/i.test(value);
  const mentionsTermination = /(finaliz|terminat|terminé|encerrad|beend|chiuso|завершён|завершен|killed|has been|foi finaliz)/i.test(value);
  if (mentionsPid && mentionsTermination) return true;
  // Bare success/error banners that only carry a PID payload.
  if (/^(ÊXITO|EXITO|SUCCESS|ERRO|ERROR|INFO|AVISO|WARN(ING)?)\s*[:!]/i.test(value) && /\bPID\b/i.test(value)) return true;
  return false;
}

/**
 * Strip process-kill noise from a free-form blob (used as the last-resort
 * fallback when a CLI produced no JSON content at all).
 */
export function stripProcessNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isProcessNoiseLine(line))
    .join('\n')
    .trim();
}

/**
 * Shared system-prompt block instructing a CLI runtime how to emit tool calls.
 * Kept here so Codex and Claude Code stay in lockstep with the parser above.
 */
export function buildMarkerToolPrompt(tools: ToolDefinition[]): string {
  return [
    'Agentis interactive chat session.',
    '',
    'You ARE Agentis. Act through Agentis tools when a tool matches the operator request.',
    'Never tell the operator to paste JSON somewhere or run something themselves — you run it.',
    '',
    'CRITICAL — NO LOCAL ENVIRONMENT:',
    '- There is NO local repository, codebase, or filesystem here for you to inspect.',
    '- Do NOT run shell commands, ripgrep/grep/find, file reads, or web/code searches. They will fail or hang and waste the operator\'s time.',
    '- The ONLY way to do anything is the AGENTIS_TOOL_CALL protocol below. Decide from the conversation and the tool list, then call the tool immediately.',
    '',
    'TOOL CALL PROTOCOL (this CLI runtime has no native function calling):',
    '- To call a tool, output exactly one line: AGENTIS_TOOL_CALL {"name":"tool.name","arguments":{ ... }}',
    '- Output the marker and NOTHING ELSE in that turn. No prose before or after, no markdown, no code fences.',
    '- Agentis executes the tool and feeds the result back to you on the next turn; then continue.',
    '- You may emit several markers (one per line) to run independent tools in one turn.',
    '- Call ONLY tools from the list below, with their exact names. Do not invent tool names.',
    '- Only answer in plain prose (no marker) when the request truly needs no tool.',
    '',
    'Available tools:',
    stableJson(tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      examples: (tool as ToolDefinition & { examples?: unknown }).examples ?? [],
      parameters: tool.parameters,
    }))),
  ].join('\n');
}

/**
 * Concise awareness block listing the Agentis platform tools available in the
 * workspace, appended to workflow-node task prompts so the agent knows the
 * platform surface exists. Informational only — workflow dispatch is
 * fire-and-forget, so this does not wire an execution loop.
 */
export function formatToolManifestAwareness(manifest?: Array<{ name: string; description: string }>): string {
  if (!manifest || manifest.length === 0) return '';
  return [
    '',
    'AGENTIS PLATFORM TOOLS available in this workspace (for your awareness):',
    ...manifest.map((tool) => `- ${tool.name}: ${tool.description}`),
  ].join('\n');
}

// ── internals ──────────────────────────────────────────────────────────────

function matchBalancedBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseMarkerPayload(raw: string): MarkerToolCall | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const payload = JSON.parse(trimmed) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const name = firstStringValue(record.name, record.toolName, record.tool);
    if (!name) return null;
    return { name, args: record.arguments ?? record.args ?? record.input ?? {} };
  } catch {
    return null;
  }
}

function firstStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}
