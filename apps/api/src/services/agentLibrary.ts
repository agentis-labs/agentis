/**
 * AgentLibraryService — Principle #11: "an agent is a file, not a record."
 *
 * Mirrors `SkillLibraryService` for agents. Platform specialists are exported to
 * `agents/platform/<role>.md` (read-only defaults); operators add `agents/custom/*.md`
 * and marketplace installs land in `agents/community/`. The creation engine reads
 * these so a workspace's *trained* specialists (or custom roles like
 * `compliance_analyst`) flow into synthesis casting — without any engine change.
 *
 * The database remains the record of what agents *did* (runs/audit/cost); the
 * filesystem defines what they *are*.
 */

import { SPECIALIST_AGENTS, ROLE_TOOLS, type AgentRole } from '@agentis/core';
import type { WorkspaceVolumeService } from './workspaceVolume.js';

const AGENTS_DIR = 'agents';

export interface AgentDefinition {
  name: string;
  role: string;
  model: string;
  tools: string[];
  capabilityTags: string[];
  colorHex?: string;
  body: string;
  source: 'platform' | 'custom' | 'community';
}

export class AgentLibraryService {
  constructor(private readonly volume: WorkspaceVolumeService) {}

  /** Export the platform specialists to `agents/platform/<role>.md` (idempotent). */
  async ensurePlatformAgents(workspaceId: string): Promise<void> {
    for (const s of SPECIALIST_AGENTS) {
      const rel = `${AGENTS_DIR}/platform/${s.role}.md`;
      if (!(await this.volume.exists(workspaceId, rel))) {
        await this.volume.write(workspaceId, rel, serialize({
          name: s.name, role: s.role, model: s.defaultModel, tools: ROLE_TOOLS[s.role],
          capabilityTags: s.capabilityTags, colorHex: s.colorHex, body: s.systemPrompt, source: 'platform',
        }));
      }
    }
  }

  /** Read every agent `.md` across platform/custom/community. */
  async list(workspaceId: string): Promise<AgentDefinition[]> {
    await this.ensurePlatformAgents(workspaceId);
    const out: AgentDefinition[] = [];
    for (const source of ['platform', 'custom', 'community'] as const) {
      const entries = await this.volume.list(workspaceId, `${AGENTS_DIR}/${source}`);
      for (const e of entries) {
        if (e.kind !== 'file' || !e.name.endsWith('.md')) continue;
        const raw = await this.volume.read(workspaceId, `${AGENTS_DIR}/${source}/${e.name}`);
        if (raw != null) out.push(parse(raw, e.name.replace(/\.md$/, ''), source));
      }
    }
    return out;
  }

  /** Custom (non-platform) roles available for casting — expands the creation vocabulary. */
  async listCustomRoles(workspaceId: string): Promise<Array<{ role: string; tools: string[]; defaultModel: string; name: string }>> {
    const all = await this.list(workspaceId);
    const platformRoles = new Set<string>(SPECIALIST_AGENTS.map((s) => s.role as string));
    return all.filter((a) => a.source !== 'platform' && !platformRoles.has(a.role))
      .map((a) => ({ role: a.role, tools: a.tools, defaultModel: a.model, name: a.name }));
  }

  /** Write/overwrite a custom agent definition. */
  async writeCustom(workspaceId: string, def: Omit<AgentDefinition, 'source'>): Promise<void> {
    await this.volume.write(workspaceId, `${AGENTS_DIR}/custom/${def.role}.md`, serialize({ ...def, source: 'custom' }));
  }
}

function serialize(def: AgentDefinition): string {
  return [
    '---',
    `name: ${def.name}`,
    `role: ${def.role}`,
    `model: ${def.model}`,
    `tools: [${def.tools.join(', ')}]`,
    `capabilityTags: [${def.capabilityTags.join(', ')}]`,
    ...(def.colorHex ? [`colorHex: "${def.colorHex}"`] : []),
    '---',
    '',
    def.body.trim(),
    '',
  ].join('\n');
}

function parse(raw: string, fallbackRole: string, source: AgentDefinition['source']): AgentDefinition {
  let name = fallbackRole, role = fallbackRole, model = 'gpt-4o-mini', colorHex: string | undefined;
  let tools: string[] = [], capabilityTags: string[] = [], body = raw;
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (fm) {
    body = fm[2] ?? '';
    for (const line of (fm[1] ?? '').split('\n')) {
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const [, k, v] = m;
      if (k === 'name') name = v!.trim();
      else if (k === 'role') role = v!.trim();
      else if (k === 'model') model = v!.trim();
      else if (k === 'colorHex') colorHex = v!.replace(/['"]/g, '').trim();
      else if (k === 'tools') tools = list(v!);
      else if (k === 'capabilityTags') capabilityTags = list(v!);
    }
  }
  return { name, role, model, tools, capabilityTags, colorHex, body: body.trim(), source };
}

function list(v: string): string[] {
  return v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function knownRole(role: string): role is AgentRole {
  return (Object.keys(ROLE_TOOLS) as string[]).includes(role);
}
