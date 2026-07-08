import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export class SpecialistTemplateService {
  constructor(private readonly db: AgentisSqliteDb) {}

  seedPlatformTemplates(): number {
    return 0;
  }

  list() {
    return this.db.select().from(schema.specialistTemplates).all();
  }
}
