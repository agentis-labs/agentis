/**
 * AgentLibraryService — Principle #11: "an agent is a file, not a record."
 *
 * Mirrors `ExtensionLibraryService` for agents. Operators add `agents/custom/*.md`
 * and marketplace installs land in `agents/community/`. The creation engine reads
 * these so a workspace's *trained* specialists (or custom roles like
 * `compliance_analyst`) flow into synthesis casting — without any engine change.
 *
 * The database remains the record of what agents *did* (runs/audit/cost); the
 * filesystem defines what they *are*.
 */

import { isAgentRole, type AgentRole } from '@agentis/core';
import type { WorkspaceVolumeService } from './workspaceVolume.js';

const AGENTS_DIR = 'agents';

export interface AgentDefinition {
  name: string;
  role: string;
  model: string;
  tools: string[];
  capabilityTags: string[];
  colorHex?: string;
  avatarGlyph?: string;
  description?: string;
  body: string;
  source: 'platform' | 'custom' | 'community' | 'generated';
}

/** On-disk source folders, in resolution order (later overrides earlier). */
const SOURCES = ['community', 'custom', 'generated'] as const;
type LibrarySource = (typeof SOURCES)[number];

export class AgentLibraryService {
  constructor(private readonly volume: WorkspaceVolumeService) {}

  /**
   * Synchronous role→definition cache, warmed by `list()` and by writes. The
   * engine resolves specialist roles synchronously at dispatch, so it can only
   * consult this cache; a cold miss falls back to a synthesized generic
   * specialist (see `SpecialistAgentService.defForRole`).
   */
  readonly #cache = new Map<string, AgentDefinition>();

  #cacheKey(workspaceId: string, role: string): string {
    return `${workspaceId}:${role}`;
  }

  /** Read a cached definition for a role without touching the volume. */
  getByRoleSync(workspaceId: string, role: string): AgentDefinition | null {
    return this.#cache.get(this.#cacheKey(workspaceId, role)) ?? null;
  }

  /** Platform specialists are no longer shipped; retained as a no-op for callers. */
  async ensurePlatformAgents(workspaceId: string): Promise<void> {
    void workspaceId;
  }

  /** Read every agent `.md` across platform/community/custom/generated. */
  async list(workspaceId: string): Promise<AgentDefinition[]> {
    await this.ensurePlatformAgents(workspaceId);
    const out: AgentDefinition[] = [];
    for (const source of SOURCES) {
      const entries = await this.volume.list(workspaceId, `${AGENTS_DIR}/${source}`);
      for (const e of entries) {
        if (e.kind !== 'file' || !e.name.endsWith('.md')) continue;
        const raw = await this.volume.read(workspaceId, `${AGENTS_DIR}/${source}/${e.name}`);
        if (raw != null) {
          const def = parse(raw, e.name.replace(/\.md$/, ''), source);
          out.push(def);
          this.#cache.set(this.#cacheKey(workspaceId, def.role), def);
        }
      }
    }
    return out;
  }

  /** Custom (non-platform) roles available for casting — expands the creation vocabulary. */
  async listCustomRoles(workspaceId: string): Promise<Array<{ role: string; tools: string[]; defaultModel: string; name: string }>> {
    const all = await this.list(workspaceId);
    return all.filter((a) => a.source !== 'platform')
      .map((a) => ({ role: a.role, tools: a.tools, defaultModel: a.model, name: a.name }));
  }

  /** Write/overwrite a human-authored custom agent definition. */
  async writeCustom(workspaceId: string, def: Omit<AgentDefinition, 'source'>): Promise<void> {
    await this.#write(workspaceId, 'custom', def);
  }

  /**
   * Write/overwrite an AI-generated specialist definition (`agents/generated/`).
   * Kept distinct from `custom` so the UI can flag generated specialists as
   * needing review before broad trust.
   */
  async writeGenerated(workspaceId: string, def: Omit<AgentDefinition, 'source'>): Promise<void> {
    await this.#write(workspaceId, 'generated', def);
  }

  async #write(workspaceId: string, source: LibrarySource, def: Omit<AgentDefinition, 'source'>): Promise<void> {
    const full: AgentDefinition = { ...def, source };
    await this.volume.write(workspaceId, `${AGENTS_DIR}/${source}/${def.role}.md`, serialize(full));
    this.#cache.set(this.#cacheKey(workspaceId, def.role), full);
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
    ...(def.avatarGlyph ? [`avatarGlyph: "${def.avatarGlyph}"`] : []),
    ...(def.description ? [`description: ${def.description.replace(/\n/g, ' ')}`] : []),
    '---',
    '',
    def.body.trim(),
    '',
  ].join('\n');
}

function parse(raw: string, fallbackRole: string, source: AgentDefinition['source']): AgentDefinition {
  let name = fallbackRole, role = fallbackRole, model = 'gpt-4o-mini';
  let colorHex: string | undefined, avatarGlyph: string | undefined, description: string | undefined;
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
      else if (k === 'avatarGlyph') avatarGlyph = v!.replace(/['"]/g, '').trim();
      else if (k === 'description') description = v!.trim();
      else if (k === 'tools') tools = list(v!);
      else if (k === 'capabilityTags') capabilityTags = list(v!);
    }
  }
  return { name, role, model, tools, capabilityTags, colorHex, avatarGlyph, description, body: body.trim(), source };
}

function list(v: string): string[] {
  return v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function knownRole(role: string): role is AgentRole {
  return isAgentRole(role);
}
