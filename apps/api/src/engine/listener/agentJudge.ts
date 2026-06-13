/**
 * Agent predicate backend — EXTENSIONS-AND-LISTENER-10X §1.4.
 *
 * The Agentis moat: an event is passed to an agent which decides — with its
 * knowledge, memory, and reasoning — whether it is worth firing the workflow.
 * We use the adapter's `chat()` stream when available, accumulate the text, and
 * decide pass/fail. If the bound agent has no chat capability, the predicate
 * fails closed with a clear reason (never silently fires).
 */

import type { ChatMessage } from '@agentis/core';
import type { AdapterManager } from '../../adapters/AdapterManager.js';
import type { Logger } from '../../logger.js';
import type { AgentJudge } from './predicate.js';

export function buildAgentJudge(adapters: AdapterManager, logger: Logger): AgentJudge {
  return async ({ agentId, prompt, event, outputField, passValues }) => {
    const reg = adapters.get(agentId);
    if (!reg?.adapter.chat) {
      return { matched: false, reason: `agent ${agentId} has no chat capability` };
    }
    const eventJson = safeJson(event);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a listener predicate. Read the event and the operator question, then reply with a single JSON object ' +
          `of the form {"${outputField}": "yes" | "no", "reason": "<short>"}. Reply with JSON only.`,
      },
      { role: 'user', content: `${prompt}\n\nEVENT:\n${eventJson}` },
    ];

    let text = '';
    try {
      for await (const delta of reg.adapter.chat(messages, [])) {
        if (delta.type === 'text') text += delta.delta;
        if (delta.type === 'done') break;
      }
    } catch (err) {
      logger.warn('listener.agent_judge.error', { agentId, err: (err as Error).message });
      return { matched: false, reason: `agent error: ${(err as Error).message}` };
    }

    return decide(text, outputField, passValues);
  };
}

function decide(text: string, outputField: string, passValues: string[]): { matched: boolean; reason?: string } {
  const lower = text.toLowerCase();
  // Prefer a structured field if the model returned JSON.
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === 'object') {
    const value = (parsed as Record<string, unknown>)[outputField];
    const reason = typeof (parsed as Record<string, unknown>).reason === 'string'
      ? ((parsed as Record<string, unknown>).reason as string)
      : undefined;
    if (value !== undefined) {
      const matched = passValues.some((v) => String(value).toLowerCase() === v.toLowerCase());
      return { matched, reason: reason ?? text.slice(0, 200) };
    }
  }
  // Fall back to keyword scan.
  const matched = passValues.some((v) => new RegExp(`\\b${escapeRegex(v.toLowerCase())}\\b`).test(lower));
  return { matched, reason: text.slice(0, 200) };
}

function tryParseJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 4000 ? `${json.slice(0, 4000)}…(truncated)` : json;
  } catch {
    return String(value);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
