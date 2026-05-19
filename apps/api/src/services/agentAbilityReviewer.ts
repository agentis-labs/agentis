/**
 * AgentAbilityReviewer — BRAIN-ABILITIES-REPLAN.md Part IV (Path 1).
 *
 * After a significant agent_task run, distils the agent's *procedure* — the
 * class-level "how to do this kind of task" — into an ability document, then
 * routes it through `AgentAbilityService.upsertFromReview` (patch an existing
 * ability or create a new one).
 *
 * The doc's terminal design uses an auxiliary LLM. Following the same
 * interim-then-terminal pattern as the BL11a extractor fix, this reviewer
 * ships a heuristic procedure extractor now and accepts an optional LLM
 * caller for the terminal upgrade. The heuristic is deliberately
 * conservative: it only writes an ability when the run exposed a genuine
 * multi-step procedure, so the library does not fill with noise.
 */

import { eq, and } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { AgentAbilityService } from './agentAbilityService.js';

/** Optional LLM caller for the terminal (non-heuristic) reviewer. */
export interface AbilityReviewLlm {
  distil(args: {
    taskTitle: string;
    taskInput: string;
    taskOutput: string;
    thinkingTrace: string;
  }): Promise<{ title: string; content: string; tags: string[] } | null>;
}

export interface AbilityReviewInput {
  workspaceId: string;
  agentId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  taskTitle?: string;
  taskInput?: unknown;
  taskOutput: unknown;
  thinkingTrace?: string[];
}

/** Minimum distinct procedural steps before an ability is worth writing. */
const MIN_STEPS = 2;

export class AgentAbilityReviewer {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly abilities: AgentAbilityService,
    private readonly logger: Logger,
    private readonly llm?: AbilityReviewLlm,
  ) {}

  /** Review one completed run. Best-effort — never throws. */
  async review(input: AbilityReviewInput): Promise<{ created: boolean; abilityId: string } | null> {
    try {
      if (!input.agentId && !input.workflowId) return null;
      const outputText = flatten(input.taskOutput);
      const traceText = (input.thinkingTrace ?? []).join('\n');
      if (outputText.length < 80 && traceText.length < 80) return null;

      const agentName = input.agentId ? this.#agentName(input.workspaceId, input.agentId) : null;
      const taskTitle = input.taskTitle?.trim() || agentName || 'Agent procedure';

      let distilled: { title: string; content: string; tags: string[] } | null = null;
      if (this.llm) {
        distilled = await this.llm.distil({
          taskTitle,
          taskInput: flatten(input.taskInput).slice(0, 4000),
          taskOutput: outputText.slice(0, 6000),
          thinkingTrace: traceText.slice(0, 6000),
        });
      }
      if (!distilled) {
        distilled = heuristicDistil(taskTitle, agentName, outputText, traceText);
      }
      if (!distilled) return null;

      const { ability, created } = await this.abilities.upsertFromReview({
        workspaceId: input.workspaceId,
        agentId: input.agentId ?? null,
        workflowId: input.agentId ? null : (input.workflowId ?? null),
        title: distilled.title,
        content: distilled.content,
        tags: distilled.tags,
        runId: input.runId ?? null,
        changeNote: 'distilled from run output + reasoning trace',
      });
      this.logger.info('ability_reviewer.applied', {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        runId: input.runId,
        created,
        abilityId: ability.id,
        via: this.llm ? 'llm' : 'heuristic',
      });
      return { created, abilityId: ability.id };
    } catch (err) {
      this.logger.warn('ability_reviewer.failed', {
        runId: input.runId,
        message: (err as Error).message,
      });
      return null;
    }
  }

  #agentName(workspaceId: string, agentId: string): string | null {
    const row = this.db.select({ name: schema.agents.name, role: schema.agents.role })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.id, agentId)))
      .get();
    return row?.name ?? null;
  }
}

// ── heuristic procedure extraction ──────────────────────────────

/**
 * Extract a class-level procedure from a run. Looks for ordered steps
 * (numbered lists) and imperative directives across the reasoning trace and
 * output. Only produces an ability when a genuine multi-step procedure is
 * present — a single sentence is a fact (brain atom), not a procedure.
 */
function heuristicDistil(
  taskTitle: string,
  agentName: string | null,
  outputText: string,
  traceText: string,
): { title: string; content: string; tags: string[] } | null {
  const combined = `${traceText}\n${outputText}`;
  const steps = extractSteps(combined);
  if (steps.length < MIN_STEPS) return null;

  const learnings = extractLearnings(outputText);
  const title = abilityTitle(taskTitle, agentName);
  const lines: string[] = [];
  lines.push(`**When to apply:** Tasks of the kind "${taskTitle}".`);
  lines.push('');
  lines.push('**Approach:**');
  steps.slice(0, 8).forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  if (learnings.length > 0) {
    lines.push('');
    lines.push('**What works:**');
    for (const learning of learnings.slice(0, 4)) lines.push(`- ${learning}`);
  }
  return {
    title,
    content: lines.join('\n'),
    tags: deriveTags(taskTitle, agentName),
  };
}

function extractSteps(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Numbered or bulleted procedural lines.
    const m = line.match(/^(?:\d+[.)]|[-*+])\s+(.{12,200})$/);
    let step: string | null = m ? m[1]!.trim() : null;
    // Imperative sentences ("Check ...", "Start with ...").
    if (!step && /^(check|start|verify|use|avoid|run|query|cross-reference|prioriti[sz]e|escalate|gather|review|compute|assign|reduce|increase|fetch|validate)\b/i.test(line) && line.length >= 16 && line.length <= 200) {
      step = line.replace(/[.;]+$/, '');
    }
    if (!step) continue;
    const key = step.toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(step);
  }
  return out;
}

function extractLearnings(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/(?:\r?\n|(?<=[.!?])\s+)/)) {
    const line = rawLine.trim().replace(/^[-*+\d.)\s]+/, '');
    if (line.length < 25 || line.length > 280) continue;
    if (/\b(works best|outperform|produced|increased|reduced|avoid|never|always|2x|3x|higher|lower|faster)\b/i.test(line)) {
      out.push(line);
    }
  }
  return [...new Set(out)];
}

function abilityTitle(taskTitle: string, agentName: string | null): string {
  const base = taskTitle.replace(/\s+/g, ' ').trim();
  const clean = base.length > 60 ? `${base.slice(0, 57)}...` : base;
  return agentName ? `${clean}` : clean;
}

function deriveTags(taskTitle: string, agentName: string | null): string[] {
  const tags = new Set<string>(['reviewed']);
  for (const word of `${taskTitle} ${agentName ?? ''}`.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    tags.add(word);
    if (tags.size >= 6) break;
  }
  return [...tags];
}

function flatten(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => flatten(v, depth + 1)).join('\n');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !/token|secret|password|authorization|cookie/i.test(k))
      .map(([, v]) => flatten(v, depth + 1))
      .join('\n');
  }
  return '';
}
