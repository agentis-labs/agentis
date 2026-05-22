/**
 * WorkspaceIntelligenceService — Layer 1 of WORKFLOW-10X-MASTERPLAN.
 *
 * Solves RC1 ("agents start from zero every task"). Reads the three persistent
 * context files from the Workspace Volume's `context/` directory —
 * WORKSPACE.md (permanent facts), MEMORY.md (append-only decision/learning log),
 * DECISIONS.md (ADRs) — and assembles a prompt block injected into every
 * agent_task dispatch and the build_workflow synthesis prompt.
 *
 * MEMORY.md is relevance-scored, not dumped wholesale: each entry carries inline
 * metadata `[date][uses:N][wf:slug][conf:low|medium|high]` that `buildContextBlock`
 * parses, scores (recency + usage + workflow match), and trims to a token budget
 * so old low-signal entries don't dilute recent high-value patterns (§1.6).
 *
 * NOTE: this is a distinct service from `WorkspaceContextService`
 * (services/workspaceContext.ts), which only resolves tenant headers. The
 * masterplan §1.3 conflated the two; this is the real context-file service.
 */

import type { WorkspaceVolumeService } from './workspaceVolume.js';

const CONTEXT_DIR = 'context';
export const CONTEXT_FILES = {
  workspace: `${CONTEXT_DIR}/WORKSPACE.md`,
  memory: `${CONTEXT_DIR}/MEMORY.md`,
  decisions: `${CONTEXT_DIR}/DECISIONS.md`,
} as const;

export type ContextFileName = 'WORKSPACE.md' | 'MEMORY.md' | 'DECISIONS.md';

export interface MemoryEntry {
  raw: string;
  text: string;
  section: string;
  timestamp: number;     // ms epoch, 0 when undated
  uses: number;
  workflowId: string;    // 'any' applies workspace-wide
  confidence: 'low' | 'medium' | 'high';
}

export interface BuildContextOptions {
  workflowId?: string;
  /** Approx token budget for the MEMORY section. Default 2000. */
  tokenBudget?: number;
  /** Max MEMORY entries to inject. Default 10. */
  maxEntries?: number;
}

const DEFAULT_WORKSPACE_MD = `# Workspace Context

## Tech Stack
_(Describe the languages, frameworks, and tools agents should always use.)_

## Architectural Rules
_(Conventions agents must never contradict without flagging.)_

## Active Integrations
_(Updated automatically as integrations are configured.)_

## Constraints
_(Budgets, do-not-do rules, approval requirements.)_
`;

const DEFAULT_MEMORY_MD = `# Session Memory Log

## Decisions Made

## Patterns That Failed

## Effective Patterns
`;

const DEFAULT_DECISIONS_MD = `# Architectural Decision Record
`;

export class WorkspaceIntelligenceService {
  constructor(
    private readonly volume: WorkspaceVolumeService,
    /** Optional: provide currently-configured integration names for the block. */
    private readonly listActiveIntegrations?: (workspaceId: string) => string[],
  ) {}

  /** Read a context file, seeding a default the first time it's requested. */
  async getContextFile(workspaceId: string, name: ContextFileName): Promise<string> {
    const rel = relFor(name);
    const existing = await this.volume.read(workspaceId, rel);
    if (existing != null) return existing;
    const seed = defaultFor(name);
    await this.volume.write(workspaceId, rel, seed);
    return seed;
  }

  /** Overwrite a context file (operator edit from Settings > Workspace > Context). */
  async setContextFile(workspaceId: string, name: ContextFileName, content: string): Promise<void> {
    await this.volume.write(workspaceId, relFor(name), content);
  }

  /** Append an entry to a MEMORY.md section (auto-maintenance, §1.4). Creates the section if absent. */
  async appendMemory(workspaceId: string, section: string, entry: string): Promise<void> {
    const current = await this.getContextFile(workspaceId, 'MEMORY.md');
    const line = entry.trim().startsWith('-') ? entry.trim() : `- ${entry.trim()}`;
    const next = upsertSection(current, section, line);
    await this.setContextFile(workspaceId, 'MEMORY.md', next);
  }

  /**
   * Assemble the prompt block injected into agent calls. Empty string when no
   * context exists yet (so prompts aren't polluted with empty headers).
   */
  async buildContextBlock(workspaceId: string, opts: BuildContextOptions = {}): Promise<string> {
    const [workspaceMd, memoryMd] = await Promise.all([
      this.getContextFile(workspaceId, 'WORKSPACE.md'),
      this.getContextFile(workspaceId, 'MEMORY.md'),
    ]);

    const entries = parseMemoryEntries(memoryMd);
    const selected = selectRelevantEntries(entries, {
      workflowId: opts.workflowId,
      tokenBudget: opts.tokenBudget ?? 2000,
      maxEntries: opts.maxEntries ?? 10,
    });

    const sections: string[] = [];
    const ws = stripPlaceholders(workspaceMd);
    if (ws.trim()) sections.push(`## Your Workspace Context\n${ws.trim()}`);

    const active = this.listActiveIntegrations?.(workspaceId) ?? [];
    if (active.length) sections.push(`## Active Integrations\n${active.join(', ')}`);

    if (selected.length) {
      const lines = selected.map((e) => `- ${e.text}${e.section ? ` _(${e.section.toLowerCase()})_` : ''}`);
      sections.push(`## Relevant Memory — apply effective patterns, avoid failed ones\n${lines.join('\n')}`);
    }

    if (!sections.length) return '';
    return `<workspace_context>\n${sections.join('\n\n')}\n</workspace_context>`;
  }
}

function relFor(name: ContextFileName): string {
  if (name === 'WORKSPACE.md') return CONTEXT_FILES.workspace;
  if (name === 'MEMORY.md') return CONTEXT_FILES.memory;
  return CONTEXT_FILES.decisions;
}

function defaultFor(name: ContextFileName): string {
  if (name === 'WORKSPACE.md') return DEFAULT_WORKSPACE_MD;
  if (name === 'MEMORY.md') return DEFAULT_MEMORY_MD;
  return DEFAULT_DECISIONS_MD;
}

/** Drop `_(placeholder)_` italic hint lines so a freshly-seeded file reads as empty. */
function stripPlaceholders(md: string): string {
  return md
    .split('\n')
    .filter((l) => !/^_\(.*\)_\s*$/.test(l.trim()))
    .join('\n');
}

/**
 * Parse MEMORY.md into structured, scoreable entries. Recognizes list items of
 * the form `- [2026-05-19][uses:3][wf:standup][conf:high] <text>` under
 * `## Section` headers. Untagged list items still parse (defaults applied) so
 * hand-written memory works too.
 */
export function parseMemoryEntries(md: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let section = '';
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd();
    const heading = /^#{2,}\s+(.*)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!item) continue;
    const body = item[1]!;
    const tags = [...body.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!);
    let timestamp = 0;
    let uses = 0;
    let workflowId = 'any';
    let confidence: MemoryEntry['confidence'] = 'medium';
    for (const tag of tags) {
      const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tag);
      if (date) { const t = Date.parse(tag); if (!Number.isNaN(t)) timestamp = t; continue; }
      const u = /^uses:(\d+)$/.exec(tag); if (u) { uses = Number(u[1]); continue; }
      const wf = /^wf:(.+)$/.exec(tag); if (wf) { workflowId = wf[1]!; continue; }
      const conf = /^conf:(low|medium|high)$/.exec(tag); if (conf) { confidence = conf[1] as MemoryEntry['confidence']; continue; }
    }
    // Text = body with all leading bracket tags stripped.
    const text = body.replace(/^(\s*\[[^\]]+\])+\s*/, '').trim();
    if (!text) continue;
    entries.push({ raw: body, text, section, timestamp, uses, workflowId, confidence });
  }
  return entries;
}

/**
 * Relevance-score and select entries within a token budget (§1.6).
 * score = recency*0.40 + usage*0.35 + workflowMatch*0.25, with a confidence nudge.
 */
export function selectRelevantEntries(
  entries: MemoryEntry[],
  ctx: { workflowId?: string; tokenBudget: number; maxEntries: number },
): MemoryEntry[] {
  const now = Date.now();
  const confWeight = { low: 0.85, medium: 1, high: 1.1 } as const;
  const scored = entries.map((e) => {
    const ageDays = e.timestamp ? (now - e.timestamp) / 86_400_000 : 45; // undated → mid-life
    const recency = Math.max(0, 1 - ageDays / 90);
    const usage = Math.min(1, e.uses / 10);
    const wfMatch = e.workflowId === ctx.workflowId ? 1 : e.workflowId === 'any' ? 0.5 : 0.3;
    const base = recency * 0.40 + usage * 0.35 + wfMatch * 0.25;
    return { entry: e, score: base * confWeight[e.confidence] };
  });
  scored.sort((a, b) => b.score - a.score);
  const out: MemoryEntry[] = [];
  let budget = ctx.tokenBudget;
  for (const s of scored) {
    if (out.length >= ctx.maxEntries) break;
    const cost = estimateTokens(s.entry.text);
    if (cost > budget) continue;
    budget -= cost;
    out.push(s.entry);
  }
  return out;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Insert a list line under a `## Section`, creating the section at the end if missing. */
function upsertSection(md: string, section: string, line: string): string {
  const lines = md.split('\n');
  const headerRe = new RegExp(`^#{2,}\\s+${escapeRegExp(section)}\\s*$`, 'i');
  const idx = lines.findIndex((l) => headerRe.test(l.trim()));
  if (idx === -1) {
    const trimmed = md.replace(/\s*$/, '');
    return `${trimmed}\n\n## ${section}\n${line}\n`;
  }
  // Insert right after the header (newest-first within the section).
  lines.splice(idx + 1, 0, line);
  return lines.join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
