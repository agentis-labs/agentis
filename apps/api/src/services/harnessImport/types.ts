/**
 * harnessImport — types shared by the agent-discovery + import layer
 * (AGENT-TRANSITION-IMPORT-10X §3, L1/L2).
 *
 * One external harness (Claude Code, Hermes, Codex, Cursor) can define *many*
 * agents on a machine. The discovery layer enumerates them into a normalized
 * `DiscoveredAgent`; the read layer produces an `ImportInputs` bundle (identity
 * + memory files with scope hints). The orchestrator then commissions an
 * Agentis agent and ingests the memory at the right Brain scope.
 *
 * Naming note: this domain's prefix is `harness*`. We deliberately avoid
 * "adapter" (= AdapterManager), "connector" (= integrations) and
 * "KnowledgeSource" (= the Grounding external-source system) — different domains.
 */

import type { V1HarnessAdapterType } from '../harnessProbe.js';

/** Where imported knowledge applies. A *hint* — the formation gate may override. */
export type ImportScopeHint = 'workspace' | 'agent';

/** What kind of source a file is, for provenance + distillation tuning. */
export type ImportFileKind = 'instruction' | 'memory' | 'persona';

/**
 * One file discovered for import (an instruction file, a memory store entry, or
 * a persona definition), annotated with a scope + type hint.
 */
export interface ImportMemoryFile {
  /** Absolute path — stable id for batch + cross-run dedup. */
  path: string;
  name: string;
  content: string;
  /** Where the knowledge applies (hint). */
  scopeHint: ImportScopeHint;
  /**
   * Frontmatter / file-type hint preserved from the source so the formation
   * gate starts from real signal: user | feedback | project | reference | rule.
   */
  typeHint?: string | null;
  kind: ImportFileKind;
}

/**
 * A harness skill (Claude/Cursor `SKILL.md` + its folder) discovered for import.
 * Skills are *capabilities*, not memories → they become Agentis Abilities (B7).
 */
export interface ImportSkill {
  /** Absolute SKILL.md path — stable id. */
  path: string;
  name: string;
  description?: string | null;
  /** SKILL.md body — fed to the Ability `material` on-ramp. */
  content: string;
  /** user/project = the operator's own (auto); marketplace = vendor (opt-in only). */
  origin: 'user' | 'project' | 'marketplace';
}

/** One external agent discovered on the machine, ready to import. */
export interface DiscoveredAgent {
  adapterType: V1HarnessAdapterType;
  /** Stable id within the harness (path / slug). Idempotency key for import. */
  externalId: string;
  name: string;
  role?: string | null;
  /** System prompt / persona / description → becomes the agent's instructions. */
  persona?: string | null;
  detectedModel?: string | null;
  /** Ready-to-use config for `commissionAgent` (binaryPath, model, cwd, …). */
  config: Record<string, unknown>;
  origin: { harness: string; rootPath: string };
  /** Cheap counts for the roster card (no file bodies). */
  summary: { memoryFiles: number; workspaceFiles: number; agentFiles: number; skills: number };
}

export interface ImportInputs {
  agent: DiscoveredAgent;
  files: ImportMemoryFile[];
  /** Skills to transition into Abilities (B7). */
  skills: ImportSkill[];
}

export interface DiscoverCtx {
  env: NodeJS.ProcessEnv;
  home: string;
  /** Optional project cwd to also scan for project-level agents/rules. */
  cwd?: string | null;
}

/** One harness's knowledge of where it keeps agents + memory (declarative). */
export interface HarnessImportSource {
  adapterType: V1HarnessAdapterType;
  /** Enumerate distinct agents this harness defines locally. */
  discover(ctx: DiscoverCtx): DiscoveredAgent[];
  /** Read identity + scope-hinted memory files for one discovered agent. */
  read(agent: DiscoveredAgent, ctx: DiscoverCtx): ImportInputs;
}
