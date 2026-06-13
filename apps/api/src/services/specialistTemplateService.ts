import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { SPECIALIST_AGENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export class SpecialistTemplateService {
  constructor(private readonly db: AgentisSqliteDb) {}

  seedPlatformTemplates(): number {
    let created = 0;
    const now = new Date().toISOString();
    for (const spec of SPECIALIST_AGENTS) {
      const existing = this.db.select({ id: schema.specialistTemplates.id }).from(schema.specialistTemplates)
        .where(eq(schema.specialistTemplates.slug, spec.role))
        .get();
      const values = {
        slug: spec.role,
        name: spec.name,
        description: spec.description,
        category: 'platform',
        defaultIdentity: { systemPrompt: spec.systemPrompt, capabilityTags: spec.capabilityTags },
        recommendedAbilities: [],
        requiredTools: spec.tools,
        defaultRuntimeProfile: { modelPolicy: spec.defaultModel, autonomyLevel: 'act_with_approval', sessionPolicy: 'stateless' },
        starterMindSources: [],
        creationQuestions: [
          `What should the ${spec.name} own?`,
          `Which sources or examples should shape its mind?`,
          `Which actions need approval?`,
        ],
        evalPack: [
          { name: 'Bounded task response', expected: 'assumptions approach output risks' },
          { name: 'Boundary recognition', expected: 'delegate escalate' },
          { name: 'Artifact discipline', expected: 'artifact summary' },
        ],
        version: 1,
        updatedAt: now,
      };
      if (existing) {
        this.db.update(schema.specialistTemplates).set(values).where(eq(schema.specialistTemplates.id, existing.id)).run();
      } else {
        this.db.insert(schema.specialistTemplates).values({ id: randomUUID(), ...values, createdAt: now }).run();
        created += 1;
      }
    }
    return created;
  }

  list() {
    return this.db.select().from(schema.specialistTemplates).all();
  }
}
