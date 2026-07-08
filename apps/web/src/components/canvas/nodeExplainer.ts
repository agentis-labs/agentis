/**
 * explainNode â€” a plain-language, CONFIG-SPECIFIC sentence describing what a
 * node does in *this* workflow. The inspector previously showed only a generic
 * per-kind blurb ("Calls an external serviceâ€¦"); this reads the node's actual
 * config so the user sees "Emails the digest to you every morning (0 9 * * *)"
 * instead of decoding raw fields. User-friendly, not dumbed-down.
 */

import { nodeKindMeta } from './nodeKindMeta';
import { isIdLike } from '../../lib/prettyRef';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function truncate(s: string, n = 90): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}â€¦` : t;
}
function humanize(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface ExplainOpts {
  /** Resolve an extension id/slug to its human name (from the installed list
   *  or the resource-name registry), so the explainer reads the real name
   *  instead of a raw identifier. */
  resolveExtensionName?: (idOrSlug: string) => string | undefined;
}

export function explainNode(kind: string, config: Record<string, unknown>, opts: ExplainOpts = {}): string {
  switch (kind) {
    case 'trigger': {
      const t = str(config.triggerType);
      if (t === 'cron') return `Runs this workflow on a schedule${str(config.schedule) ? ` (${str(config.schedule)})` : ''}.`;
      if (t === 'webhook') return 'Runs this workflow when an external webhook calls it.';
      if (t === 'persistent_listener') return 'Runs this workflow every time a watched source emits a matching event.';
      return 'Starts this workflow when you run it.';
    }
    case 'http_request': {
      const url = str(config.url);
      return url ? `Fetches ${truncate(url, 60)} so later steps can use the data.` : 'Fetches data from a URL so later steps can use it.';
    }
    case 'agent_task': {
      const role = str(config.agentRole);
      const prompt = str(config.prompt);
      const who = role ? `the ${role} specialist` : 'a specialist agent';
      return prompt ? `${humanize(who)} works on: ${truncate(prompt)}` : `${humanize(who)} reasons over the input and produces the work product.`;
    }
    case 'agent_swarm':
    case 'dynamic_swarm':
      return 'Fans the work out across parallel specialist agents and merges their results.';
    case 'integration': {
      const service = str(config.integrationId) || str(config.service);
      const op = str(config.operationId) || str(config.operation);
      const to = str((config.inputs as Record<string, unknown> | undefined)?.to) || str(config.to);
      const label = service ? humanize(service) : 'an external service';
      const action = op ? humanize(op) : 'an action';
      return `${action} via ${label}${to ? ` to ${to}` : ''}.`;
    }
    case 'notify':
      return 'Sends the result to you â€” delivered to your account, no setup needed.';
    case 'parallel':
      return 'Runs the branches below at the same time, then joins their results.';
    case 'merge':
      return 'Combines the parallel branches back into a single result.';
    case 'transform':
      return 'Reshapes the data deterministically â€” no AI, no tokens spent.';
    case 'filter':
      return 'Keeps only the items that match a condition.';
    case 'evaluator':
      return 'Scores the previous step and gates what happens next â€” a quality guard.';
    case 'guardrails':
      return 'Checks the output against safety/policy rules before it continues.';
    case 'knowledge':
      return 'Pulls the most relevant passages from your workspace knowledge before the next step.';
    case 'workflow_store':
      return 'Remembers state between runs (e.g. what was already seen) so each run builds on the last.';
    case 'workspace_store':
      return 'Reads or writes shared workspace state available to every workflow.';
    case 'return_output':
      return 'Produces the final result shown in the Output tab.';
    case 'artifact_save':
      return 'Saves the result as a downloadable artifact.';
    case 'checkpoint':
      return 'Pauses for a human to approve before continuing.';
    case 'loop':
      return 'Repeats the downstream steps once for each item.';
    case 'pursue':
      return 'Pursues an objective â€” re-runs a cohort, measures progress, and reflects when stuck until done, stalled, or out of budget.';
    case 'converge':
      return 'Re-runs a cohort of agents until a goal is met, stalls, or hits its budget.';
    case 'wait': {
      const d = str(config.duration) || str(config.delay);
      return d ? `Pauses for ${d} before continuing.` : 'Pauses for a set duration before continuing.';
    }
    case 'router':
      return 'Sends the run down different branches based on a condition.';
    case 'extension_task': {
      // Prefer the resolved human name, then a readable slug â€” never a raw UUID.
      const extId = str(config.extensionId) || str(config.extension);
      const extSlug = str(config.extensionSlug);
      const resolved = opts.resolveExtensionName?.(extId || extSlug);
      const extRaw = (resolved && resolved.trim())
        || (extSlug && !isIdLike(extSlug) ? extSlug : '')
        || (extId && !isIdLike(extId) ? extId : '');
      const ext = extRaw.trim();
      const opRaw = str(config.operationName) || str(config.operation);
      const op = opRaw && !isIdLike(opRaw) ? opRaw : '';
      return ext
        ? `Runs the ${humanize(ext)}${op ? ` Â· ${humanize(op)}` : ''} extension operation.`
        : op ? `Runs the ${humanize(op)} extension operation.` : 'Runs an extension operation.';
    }
    case 'subflow':
      return 'Runs a reusable sub-workflow as a single step.';
    case 'browser':
      return 'Controls a real browser â€” render a page or capture a screenshot.';
    case 'scratchpad':
      return 'Holds working variables for the run.';
    default:
      return `${nodeKindMeta(kind).label} step.`;
  }
}



