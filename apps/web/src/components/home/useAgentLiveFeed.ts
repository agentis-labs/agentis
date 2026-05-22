/**
 * useAgentLiveFeed — agent-centric live activity for the canvas.
 *
 * Replaces the event-centric `buildCanvasActivityItems` pipeline. Instead of
 * a flat list of run/approval/failure items, this hook keeps a per-agent
 * stream of what each agent is doing right now, fed by realtime events:
 *
 *   AGENT_WORK_STEP          → engine node start/complete/fail (named agent)
 *   AGENT_TERMINAL_TOOL_CALL → adapter tool invocations
 *   AGENT_TERMINAL_MESSAGE   → adapter thought/terminal output
 *
 * Sections are ordered orchestrator → managers → workers to mirror the
 * canvas hierarchy. Runs without an attributed agent collapse into a
 * synthetic `run:<id>` section so skill-only workflows still surface.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { REALTIME_EVENTS } from '@agentis/core';
import { workspace as workspaceStore } from '../../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import type { WorkspaceActiveRun, WorkspaceAgent, WorkspaceApproval } from '../../lib/workspaceData';

export type FeedLineKind = 'step' | 'tool' | 'message' | 'done' | 'fail';
export type AgentFeedStatus = 'working' | 'waiting' | 'done' | 'failed';
export type AgentFeedRole = 'orchestrator' | 'manager' | 'worker';

export interface FeedLine {
  id: string;
  kind: FeedLineKind;
  text: string;
  at: number;
}

export interface AgentFeedSection {
  key: string;
  agentId: string | null;
  name: string;
  glyph?: string | null;
  colorHex?: string | null;
  role: AgentFeedRole;
  status: AgentFeedStatus;
  headline?: string;
  lines: FeedLine[];
  approval?: WorkspaceApproval;
  progress?: { done: number; total: number };
  lastActivityAt: number;
}

interface AgentStream {
  lines: FeedLine[];
  progress?: { done: number; total: number };
  lastAt: number;
  failed: boolean;
  nameHint?: string;
}

const MAX_LINES = 24;
const DONE_RETENTION_MS = 5 * 60_000;
const MAX_DONE_SECTIONS = 2;
const FEED_EVENTS = [
  REALTIME_EVENTS.AGENT_WORK_STEP,
  REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL,
  REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE,
] as const;

export function useAgentLiveFeed(
  agents: WorkspaceAgent[],
  activeRuns: WorkspaceActiveRun[],
  approvals: WorkspaceApproval[],
): AgentFeedSection[] {
  const [streams, setStreams] = useState<Record<string, AgentStream>>({});
  const [now, setNow] = useState(() => Date.now());
  const seqRef = useRef(0);

  // Tick so relative time + done-retention re-evaluate without new events.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  // Workspace room carries engine AGENT_WORK_STEP events.
  useEffect(() => {
    const ws = workspaceStore.get();
    return ws ? rtSubscribe('workspace', { workspaceId: ws }) : undefined;
  }, []);

  // Agent rooms carry adapter terminal/tool events.
  const liveAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of activeRuns) for (const a of run.agents ?? []) ids.add(a.id);
    for (const agent of agents) if (isWorkingStatus(agent.status)) ids.add(agent.id);
    return Array.from(ids).sort();
  }, [agents, activeRuns]);

  useEffect(() => {
    const unsubs = liveAgentIds.map((agentId) => rtSubscribe('agent', { agentId }));
    return () => unsubs.forEach((fn) => fn());
  }, [liveAgentIds.join('|')]);

  useRealtime([...FEED_EVENTS], (env) => {
    const line = describeEvent(env);
    if (!line) return;
    seqRef.current += 1;
    const lineId = `${env.event}-${env.emittedAt}-${seqRef.current}`;
    setStreams((current) => {
      const prev = current[line.key];
      const nextLines = [
        ...(prev?.lines ?? []),
        { id: lineId, kind: line.kind, text: line.text, at: Date.now() },
      ].slice(-MAX_LINES);
      return {
        ...current,
        [line.key]: {
          lines: nextLines,
          progress: line.progress ?? prev?.progress,
          lastAt: Date.now(),
          failed: line.kind === 'fail' ? true : line.kind === 'step' ? false : prev?.failed ?? false,
          nameHint: line.nameHint ?? prev?.nameHint,
        },
      };
    });
  });

  return useMemo(
    () => buildSections(agents, activeRuns, approvals, streams, now),
    [agents, activeRuns, approvals, streams, now],
  );
}

interface ParsedLine {
  key: string;
  kind: FeedLineKind;
  text: string;
  progress?: { done: number; total: number };
  nameHint?: string;
}

function describeEvent(env: RealtimeEnvelope): ParsedLine | null {
  const p = isRecord(env.payload) ? env.payload : {};
  const agentId = stringField(p, ['agentId']);
  const runId = stringField(p, ['runId']);
  const key = agentId ?? (runId ? `run:${runId}` : null);
  if (!key) return null;
  const nameHint = stringField(p, ['agentName']);

  if (env.event === REALTIME_EVENTS.AGENT_WORK_STEP) {
    const phase = stringField(p, ['phase']);
    const text = stringField(p, ['description', 'summary', 'step', 'message']) ?? 'Working';
    const progress = parseProgress(p.progress);
    const kind: FeedLineKind = phase === 'fail' ? 'fail' : phase === 'complete' ? 'done' : 'step';
    return { key, kind, text, progress, nameHint };
  }
  if (env.event === REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL) {
    const tool = stringField(p, ['tool', 'name', 'command']) ?? 'tool call';
    return { key, kind: 'tool', text: tool, nameHint };
  }
  if (env.event === REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE) {
    const text = stringField(p, ['message', 'text', 'line']);
    if (!text) return null;
    return { key, kind: 'message', text, nameHint };
  }
  return null;
}

function buildSections(
  agents: WorkspaceAgent[],
  activeRuns: WorkspaceActiveRun[],
  approvals: WorkspaceApproval[],
  streams: Record<string, AgentStream>,
  now: number,
): AgentFeedSection[] {
  const ordered = [...agents].sort((a, b) => roleRank(a) - roleRank(b));
  const runByAgent = new Map<string, WorkspaceActiveRun>();
  for (const run of activeRuns) {
    for (const a of run.agents ?? []) if (!runByAgent.has(a.id)) runByAgent.set(a.id, run);
  }
  const usedApprovalIds = new Set<string>();
  const sections: AgentFeedSection[] = [];

  for (const agent of ordered) {
    const stream = streams[agent.id];
    const run = runByAgent.get(agent.id);
    const approval =
      approvals.find((a) => a.agentName && a.agentName === agent.name) ??
      (run ? approvals.find((a) => a.runId && a.runId === run.id) : undefined);
    const active = Boolean(run);
    const fresh = stream && now - stream.lastAt < DONE_RETENTION_MS;
    if (!active && !approval && !fresh) continue;
    if (approval) usedApprovalIds.add(approval.id);

    const status: AgentFeedStatus = approval
      ? 'waiting'
      : active
        ? 'working'
        : stream?.failed
          ? 'failed'
          : 'done';
    sections.push({
      key: `agent:${agent.id}`,
      agentId: agent.id,
      name: agent.name,
      glyph: agent.avatarGlyph,
      colorHex: agent.colorHex,
      role: roleOf(agent),
      status,
      headline: run?.workflowName,
      lines: stream?.lines ?? [],
      approval,
      progress: stream?.progress ?? runProgress(run),
      lastActivityAt: stream?.lastAt ?? startMs(run?.startedAt) ?? now,
    });
  }

  // Synthetic sections for runs streaming under `run:<id>` (no named agent).
  for (const [key, stream] of Object.entries(streams)) {
    if (!key.startsWith('run:')) continue;
    const runId = key.slice(4);
    const run = activeRuns.find((r) => r.id === runId);
    const fresh = now - stream.lastAt < DONE_RETENTION_MS;
    if (!run && !fresh) continue;
    sections.push({
      key,
      agentId: null,
      name: run?.workflowName ?? stream.nameHint ?? 'Workflow run',
      role: 'worker',
      status: run ? 'working' : stream.failed ? 'failed' : 'done',
      lines: stream.lines,
      progress: stream.progress ?? runProgress(run),
      lastActivityAt: stream.lastAt,
    });
  }

  // Orphan approvals — pending review with no matched agent section.
  for (const approval of approvals) {
    if (usedApprovalIds.has(approval.id)) continue;
    sections.push({
      key: `approval:${approval.id}`,
      agentId: null,
      name: approval.agentName ?? 'Approval needed',
      role: 'worker',
      status: 'waiting',
      headline: approval.workflowName,
      lines: [],
      approval,
      lastActivityAt: startMs(approval.createdAt) ?? now,
    });
  }

  // Keep every working/waiting/failed section; cap completed ones.
  const live = sections.filter((s) => s.status !== 'done');
  const done = sections
    .filter((s) => s.status === 'done')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, MAX_DONE_SECTIONS);
  return [...live, ...done].sort((a, b) => sortRank(a) - sortRank(b));
}

function sortRank(s: AgentFeedSection): number {
  const statusWeight = s.status === 'waiting' ? 0 : s.status === 'working' ? 1 : s.status === 'failed' ? 2 : 3;
  const roleWeight = s.role === 'orchestrator' ? 0 : s.role === 'manager' ? 1 : 2;
  return statusWeight * 10 + roleWeight;
}

function roleOf(agent: WorkspaceAgent): AgentFeedRole {
  const role = (agent.role ?? '').toLowerCase();
  if (role.includes('orchestrator')) return 'orchestrator';
  if (!role && /orchestrator/i.test(agent.name)) return 'orchestrator';
  if (role.includes('manager') || role.includes('lead')) return 'manager';
  return 'worker';
}

function roleRank(agent: WorkspaceAgent): number {
  const role = roleOf(agent);
  return role === 'orchestrator' ? 0 : role === 'manager' ? 1 : 2;
}

function isWorkingStatus(status: string | undefined): boolean {
  return status === 'active' || status === 'running' || status === 'busy';
}

function runProgress(run: WorkspaceActiveRun | undefined): { done: number; total: number } | undefined {
  if (!run || run.stepIndex == null || run.totalSteps == null || run.totalSteps <= 0) return undefined;
  return { done: run.stepIndex, total: run.totalSteps };
}

function parseProgress(value: unknown): { done: number; total: number } | undefined {
  if (!isRecord(value)) return undefined;
  const done = typeof value.done === 'number' ? value.done : undefined;
  const total = typeof value.total === 'number' ? value.total : undefined;
  if (done == null || total == null || total <= 0) return undefined;
  return { done, total };
}

function startMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
