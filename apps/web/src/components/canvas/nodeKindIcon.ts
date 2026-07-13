/**
 * nodeKindIcon — one real (lucide) icon per workflow node kind.
 *
 * The canvas card, the palette, and the command palette all draw the same icon
 * for a kind, so a step reads identically everywhere (reference-builder
 * parity: crisp pictograms instead of unicode glyphs). Brand surfaces
 * (integration / mcp nodes with a known provider) override this with a real
 * connector logo at the call site — this map is the kind-level fallback and
 * the identity for every abstract kind.
 */

import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  ArrowDownToLine,
  BadgeCheck,
  Bell,
  BookOpen,
  BookUp,
  Bot,
  BotMessageSquare,
  Boxes,
  CalendarClock,
  CodeXml,
  Database,
  DatabaseZap,
  FilePenLine,
  Funnel,
  GitBranch,
  GitMerge,
  Globe,
  HardDrive,
  Hexagon,
  KeyRound,
  ListTree,
  MessageCircle,
  Network,
  NotebookPen,
  OctagonX,
  Package,
  Plug,
  PlugZap,
  Puzzle,
  RefreshCw,
  Repeat,
  Target,
  Scale,
  SendHorizontal,
  ShieldCheck,
  Sigma,
  Split,
  SquareCode,
  SquareFunction,
  StickyNote,
  Table2,
  TextCursorInput,
  Timer,
  TriangleAlert,
  UserCheck,
  UserPen,
  Users,
  Workflow,
  Zap,
} from 'lucide-react';

const NODE_KIND_ICON: Record<string, LucideIcon> = {
  // Control flow
  trigger: Zap,
  router: GitBranch,
  merge: GitMerge,
  subflow: Boxes,
  wait: Timer,
  loop: Repeat,
  converge: RefreshCw,
  pursue: Target,
  parallel: Split,
  stop_error: OctagonX,
  // Data & logic
  transform: SquareFunction,
  filter: Funnel,
  integration: Plug,
  mcp: PlugZap,
  channel: MessageCircle,
  http_request: Globe,
  graphql: Hexagon,
  data_query: DatabaseZap,
  data_mutate: FilePenLine,
  aggregate_window: Sigma,
  workflow_store: Database,
  workspace_store: HardDrive,
  scratchpad: NotebookPen,
  code: SquareCode,
  datetime: CalendarClock,
  crypto_util: KeyRound,
  markdown: CodeXml,
  xml_parse: CodeXml,
  html_extract: TextCursorInput,
  json_schema_validate: BadgeCheck,
  spreadsheet: Table2,
  // Intelligence
  agent_task: Bot,
  agent_session: BotMessageSquare,
  extension_task: Puzzle,
  agent_swarm: Users,
  dynamic_swarm: Network,
  planner: ListTree,
  evaluator: Scale,
  guardrails: ShieldCheck,
  // Knowledge
  knowledge: BookOpen,
  knowledge_ingest: BookUp,
  artifact_collect: Package,
  // Output
  return_output: SendHorizontal,
  artifact_save: ArrowDownToLine,
  notify: Bell,
  sticky_note: StickyNote,
  // Native browser
  browser: AppWindow,
  // Human
  checkpoint: UserCheck,
  human_input: UserPen,
  // Failure-driven trigger
  error_trigger: TriangleAlert,
};

/** The lucide icon for a node kind, with a safe generic fallback. */
export function nodeKindIcon(kind: string | undefined | null): LucideIcon {
  if (!kind) return Workflow;
  return NODE_KIND_ICON[kind] ?? Workflow;
}
