/**
 * EvalHarness — agent-experience (AX) evaluation (Agent-Native §3.2 / H3).
 *
 * The regression gate that keeps the platform buildable-by-agents. It runs realistic
 * COLD-START build tasks against a seeded workspace and grades the OUTCOME — the
 * actual workspace state, never the agent's self-report (Anthropic "Demystifying
 * evals": grade the outcome, not the path). Two universal signals matter most:
 * did the task's success criteria hold, and were ANY duplicate resources created
 * (must be 0 — the #1 field failure this whole plan exists to kill).
 *
 * A "solver" is agent-written code (run through code-mode against the real tool
 * registry). In CI without a model, scripted solvers prove the graders; with a
 * model, the same harness scores model-generated code — the solver is the only part
 * that changes. Vocabulary: task → grader → trial → transcript → outcome; pass@k
 * (possible at all) vs pass^k (reliably), computed by scoreTrials.
 */

import { and, eq, ne } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AgentisToolContext } from '@agentis/core';
import type { CodeModeService } from './codeMode.js';

export interface ToolCallRecord { tool: string; ok: boolean; code?: string }

export interface GradeResult { name: string; pass: boolean; detail?: string }

export interface GradeContext {
  db: AgentisSqliteDb;
  workspaceId: string;
  /** What the solver actually did — for path-aware checks (e.g. tool-call count). */
  transcript: ToolCallRecord[];
  /** The solver's returned value. */
  result: unknown;
}

export interface EvalGrader {
  name: string;
  check: (ctx: GradeContext) => GradeResult | Promise<GradeResult>;
}

export interface EvalTask {
  id: string;
  description: string;
  graders: EvalGrader[];
}

export interface EvalTrial {
  taskId: string;
  /** True only when the solver ran cleanly, every grader passed, AND zero duplicates. */
  ok: boolean;
  grades: GradeResult[];
  /** Number of duplicate resources created (apps/workflows sharing a normalized name). MUST be 0. */
  duplicates: number;
  toolCalls: number;
  error?: string;
}

export class EvalHarness {
  constructor(
    private readonly codeMode: CodeModeService,
    private readonly db: AgentisSqliteDb,
  ) {}

  /** Run one task with one solver (agent code) and grade the resulting state. */
  async runTrial(task: EvalTask, solverCode: string, ctx: AgentisToolContext): Promise<EvalTrial> {
    const res = await this.codeMode.execute({ code: solverCode, ctx });
    const transcript: ToolCallRecord[] = res.calls;
    const gradeCtx: GradeContext = { db: this.db, workspaceId: ctx.workspaceId, transcript, result: res.ok ? res.result : undefined };

    const grades: GradeResult[] = [];
    if (!res.ok) {
      // A solver that crashed can still be graded on the state it left; record why.
      grades.push({ name: 'solver_completed', pass: false, detail: `${res.error?.code}: ${res.error?.message}` });
    }
    for (const g of task.graders) grades.push(await g.check(gradeCtx));

    const duplicates = this.countDuplicateResources(ctx.workspaceId);
    const ok = res.ok && grades.every((g) => g.pass) && duplicates === 0;
    return { taskId: task.id, ok, grades, duplicates, toolCalls: transcript.length, ...(res.ok ? {} : { error: res.error?.message }) };
  }

  /**
   * Universal duplicate detector — the load-bearing AX metric. Counts extra
   * resources that share a normalized name within a kind (apps, workflows),
   * excluding archived. Returns the count of DUPLICATES (0 = clean).
   */
  countDuplicateResources(workspaceId: string): number {
    const apps = this.db.select({ name: schema.apps.name }).from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), ne(schema.apps.status, 'archived'))).all();
    const workflows = this.db.select({ title: schema.workflows.title }).from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, workspaceId)).all();
    return extras(apps.map((a) => a.name)) + extras(workflows.map((w) => w.title));
  }
}

/** pass@k (at least one trial ok — is it possible at all) vs pass^k (all ok — is it reliable). */
export function scoreTrials(trials: EvalTrial[]): { n: number; passAtK: number; passHatK: number; avgDuplicates: number; avgToolCalls: number } {
  const n = trials.length;
  if (n === 0) return { n: 0, passAtK: 0, passHatK: 0, avgDuplicates: 0, avgToolCalls: 0 };
  const passed = trials.filter((t) => t.ok).length;
  return {
    n,
    passAtK: passed > 0 ? 1 : 0,
    passHatK: passed === n ? 1 : 0,
    avgDuplicates: trials.reduce((s, t) => s + t.duplicates, 0) / n,
    avgToolCalls: trials.reduce((s, t) => s + t.toolCalls, 0) / n,
  };
}

/** How many entries beyond the first share a normalized name (the duplicate count). */
function extras(names: string[]): number {
  const counts = new Map<string, number>();
  for (const raw of names) {
    const key = raw.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let dupes = 0;
  for (const c of counts.values()) if (c > 1) dupes += c - 1;
  return dupes;
}
