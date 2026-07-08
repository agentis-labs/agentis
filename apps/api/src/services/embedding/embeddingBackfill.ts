import type { Logger } from '../../logger.js';
import type { KnowledgeBaseService } from '../knowledge/knowledgeBase.js';

export class EmbeddingBackfillService {
  constructor(
    private readonly knowledgeBases: KnowledgeBaseService,
    private readonly logger: Logger,
  ) {}

  async run(workspaceId: string): Promise<{ embedded: number; failed: number }> {
    const result = await this.knowledgeBases.backfillEmbeddings(workspaceId);
    this.logger.info('knowledge.embedding_backfill.completed', { workspaceId, ...result });
    return result;
  }
}
