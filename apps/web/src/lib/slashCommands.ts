/**
 * Global slash-command dispatcher.
 *
 * The ChatPanel composer fires `agentis:slash-command` window events with
 * `{cmd, raw}` detail. We listen at the Shell level so commands like
 * `/history`, `/status`, `/help` can navigate the app or surface UI no
 * matter where the panel happens to be focused.
 *
 * Commands that need backend work (`/run`, `/pause`, `/wake`) resolve names
 * from the current workspace and call the same REST endpoints as the UI.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../components/shared/Toast';
import { api, type ApiError } from './api';

interface SlashDetail {
  cmd: string;
  raw: string;
}

interface AgentRow {
  id: string;
  name: string;
  isPaused?: boolean;
}

interface WorkflowRow {
  id: string;
  title: string;
}

interface RunWorkflowResponse {
  runId?: string;
  queueId?: string;
}

export function useGlobalSlashCommands() {
  const nav = useNavigate();
  const toast = useToast();

  useEffect(() => {
    async function runWorkflow(raw: string) {
      const target = raw.trim();
      if (!target) {
        toast.info('Choose a workflow', 'Use /run #workflow-name or open the workflow list.');
        nav('/workflows');
        return;
      }
      try {
        const data = await api<{ workflows: WorkflowRow[] }>('/v1/workflows?includeMissions=1');
        const workflow = resolveByHandle(data.workflows ?? [], target, (item) => [item.id, item.title]);
        if (!workflow) {
          toast.warn('Workflow not found', `No workflow matched "${target}".`);
          return;
        }
        const result = await api<RunWorkflowResponse>(`/v1/workflows/${workflow.id}/run`, {
          method: 'POST',
          body: JSON.stringify({ inputs: {} }),
        });
        if (result.runId) {
          toast.success('Workflow started', workflow.title);
          nav(`/runs/${result.runId}`);
          return;
        }
        toast.success('Workflow queued', workflow.title);
        nav('/history');
      } catch (err) {
        toast.error('Run failed', errorMessage(err));
      }
    }

    async function pauseAgent(raw: string) {
      const agent = await findAgent(raw);
      if (!agent) return;
      try {
        await api(`/v1/agents/${agent.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ isPaused: true }),
        });
        toast.success('Agent paused', agent.name);
      } catch (err) {
        toast.error('Pause failed', errorMessage(err));
      }
    }

    async function wakeAgent(raw: string) {
      const agent = await findAgent(raw);
      if (!agent) return;
      try {
        if (agent.isPaused) {
          await api(`/v1/agents/${agent.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ isPaused: false }),
          });
        }
        await api(`/v1/agents/${agent.id}/wake`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'slash-command' }),
        });
        toast.success('Wake signal sent', agent.name);
      } catch (err) {
        toast.error('Wake failed', errorMessage(err));
      }
    }

    async function findAgent(raw: string): Promise<AgentRow | null> {
      const target = raw.trim();
      if (!target) {
        toast.info('Choose an agent', 'Use /pause @agent-name or /wake @agent-name.');
        return null;
      }
      try {
        const data = await api<{ agents: AgentRow[] }>('/v1/agents');
        const agent = resolveByHandle(data.agents ?? [], target, (item) => [item.id, item.name]);
        if (!agent) {
          toast.warn('Agent not found', `No agent matched "${target}".`);
          return null;
        }
        return agent;
      } catch (err) {
        toast.error('Agent lookup failed', errorMessage(err));
        return null;
      }
    }

    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<SlashDetail>).detail;
      if (!detail) return;
      switch (detail.cmd) {
        case 'history':
          nav('/history');
          return;
        case 'status':
          nav('/home');
          return;
        case 'approve':
          window.dispatchEvent(new CustomEvent('agentis:open-notifications'));
          return;
        case 'help':
          toast.info(
            'Slash commands',
            '/run · /pause · /wake · /approve · /history · /status · /help',
          );
          return;
        case 'run':
          void runWorkflow(detail.raw);
          return;
        case 'pause':
          void pauseAgent(detail.raw);
          return;
        case 'wake':
          void wakeAgent(detail.raw);
          return;
        default:
          toast.info('Unknown command', `Type /help for the list of slash commands.`);
      }
    };
    window.addEventListener('agentis:slash-command', handler);

    const proactive = (ev: Event) => {
      const detail = (ev as CustomEvent<{ action: string; params?: Record<string, unknown> }>)
        .detail;
      if (!detail) return;
      // Convention: actions starting with "/" are routes.
      if (detail.action.startsWith('/')) {
        nav(detail.action);
        return;
      }
      // Otherwise treat as a slash command alias.
      window.dispatchEvent(
        new CustomEvent('agentis:slash-command', {
          detail: { cmd: detail.action, raw: '' },
        }),
      );
    };
    window.addEventListener('agentis:proactive-action', proactive);

    return () => {
      window.removeEventListener('agentis:slash-command', handler);
      window.removeEventListener('agentis:proactive-action', proactive);
    };
  }, [nav, toast]);
}

function resolveByHandle<T>(items: T[], raw: string, labelsOf: (item: T) => string[]): T | null {
  const candidates = targetCandidates(raw);
  for (const candidate of candidates) {
    const exact = items.find((item) => labelsOf(item).some((label) => label === candidate));
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const key = handleKey(candidate);
    const exact = items.find((item) => labelsOf(item).some((label) => handleKey(label) === key));
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const key = handleKey(candidate);
    const matches = items.filter((item) => labelsOf(item).some((label) => handleKey(label).includes(key)));
    if (matches.length === 1) return matches[0] ?? null;
  }
  return null;
}

function targetCandidates(raw: string): string[] {
  const trimmed = raw.trim().replace(/^[@#]/, '');
  const firstToken = trimmed.split(/\s+/)[0] ?? '';
  return [trimmed, firstToken].filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);
}

function handleKey(value: string): string {
  return value.toLowerCase().replace(/^[@#]/, '').replace(/[_-]+/g, ' ').replace(/[^a-z0-9]+/g, '');
}

function errorMessage(err: unknown): string {
  const apiError = err as Partial<ApiError> | undefined;
  return apiError?.message ?? (err instanceof Error ? err.message : 'Unexpected error');
}
