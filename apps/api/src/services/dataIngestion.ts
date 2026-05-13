import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError, type DatasetSpec } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { KnowledgeBaseService } from './knowledgeBase.js';
import {
  AppInstanceService,
  appDto,
  objectRecord,
  parseAgentisContents,
  type AppInstanceRow,
} from './appInstances.js';

export interface IngestDatasetArgs {
  workspaceId: string;
  userId: string;
  appSlug: string;
  datasetKey: string;
  sourceFormat: string;
  name?: string;
  mimeType?: string;
  content?: string;
  records?: unknown[];
  urls?: string[];
}

interface NormalizedRecord {
  title: string;
  content: string;
  fields?: Record<string, unknown>;
}

export class DataIngestionService {
  private readonly apps: AppInstanceService;

  constructor(private readonly deps: { db: AgentisSqliteDb; knowledge: KnowledgeBaseService }) {
    this.apps = new AppInstanceService(deps.db);
  }

  listJobs(workspaceId: string, appSlug: string, datasetKey?: string) {
    const app = this.apps.getBySlug(workspaceId, appSlug);
    return this.deps.db
      .select()
      .from(schema.dataIngestionJobs)
      .where(and(eq(schema.dataIngestionJobs.workspaceId, workspaceId), eq(schema.dataIngestionJobs.appInstanceId, app.id)))
      .all()
      .filter((job) => !datasetKey || job.datasetKey === datasetKey)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  preview(args: IngestDatasetArgs) {
    const app = this.apps.getBySlug(args.workspaceId, args.appSlug);
    const contents = parseAgentisContents(app.packageContents);
    const datasetSpec = contents.datasetSpecs.find((spec) => spec.key === args.datasetKey);
    if (!datasetSpec) throw new AgentisError('RESOURCE_NOT_FOUND', 'Dataset spec not found');
    assertAcceptedFormat(args.sourceFormat, datasetSpec);

    const records = normalizeRecords(args, datasetSpec);
    validateRequiredFields(records, datasetSpec);
    const columns = [...new Set(records.flatMap((record) => Object.keys(record.fields ?? {})))];
    const warnings: string[] = [];
    if (datasetSpec.sizeWarningAboveRows && records.length > datasetSpec.sizeWarningAboveRows) {
      warnings.push(`Dataset has ${records.length} rows; expected warning threshold is ${datasetSpec.sizeWarningAboveRows}.`);
    }
    return {
      dataset: datasetSpec,
      accepted: true,
      recordCount: records.length,
      columns,
      previewRows: records.slice(0, 10).map((record) => ({ title: record.title, fields: record.fields ?? { content: record.content } })),
      warnings,
      sourceHash: sourceHash(args),
      byteSize: Buffer.byteLength(JSON.stringify({ content: args.content, records: args.records, urls: args.urls }), 'utf8'),
    };
  }

  ingest(args: IngestDatasetArgs) {
    const app = this.apps.getBySlug(args.workspaceId, args.appSlug);
    const contents = parseAgentisContents(app.packageContents);
    const datasetSpec = contents.datasetSpecs.find((spec) => spec.key === args.datasetKey);
    if (!datasetSpec) throw new AgentisError('RESOURCE_NOT_FOUND', 'Dataset spec not found');
    assertAcceptedFormat(args.sourceFormat, datasetSpec);

    const records = normalizeRecords(args, datasetSpec);
    validateRequiredFields(records, datasetSpec);

    const now = new Date().toISOString();
    const jobId = randomUUID();
    const byteSize = Buffer.byteLength(JSON.stringify({ content: args.content, records: args.records, urls: args.urls }), 'utf8');
    const previewRows = records.slice(0, 10).map((record) => ({ title: record.title, fields: record.fields ?? { content: record.content } }));
    this.deps.db
      .insert(schema.dataIngestionJobs)
      .values({
        id: jobId,
        appInstanceId: app.id,
        workspaceId: args.workspaceId,
        userId: args.userId,
        datasetKey: args.datasetKey,
        sourceFormat: args.sourceFormat,
        status: 'processing',
        currentPhase: 'parsing',
        progressMessage: 'Parsing source data',
        sourceHash: sourceHash(args),
        totalItems: records.length,
        processedItems: 0,
        errorItems: 0,
        byteSize,
        chunkCount: 0,
        embeddingCount: 0,
        previewRows,
        estimatedCompletionAt: null,
        errorMessage: null,
        startedAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    try {
      this.updateJobPhase(jobId, 'indexing', 'Writing normalized records');
      const result = this.ingestIntoTarget(app, datasetSpec, records, args, jobId, now);
      const completedAt = new Date().toISOString();
      this.deps.db
        .update(schema.dataIngestionJobs)
        .set({
          status: 'completed',
          currentPhase: 'done',
          progressMessage: 'Import completed',
          processedItems: records.length,
          chunkCount: result.chunkCount,
          embeddingCount: result.embeddingCount,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(schema.dataIngestionJobs.id, jobId))
        .run();
      const updatedApp = this.updateDatasetStatus(app, datasetSpec, {
        status: 'imported',
        sourceFormat: args.sourceFormat,
        totalItems: records.length,
        processedItems: records.length,
        chunkCount: result.chunkCount,
        embeddingCount: result.embeddingCount,
        byteSize,
        lastJobId: jobId,
        knowledgeBaseId: result.knowledgeBaseId,
        importedAt: completedAt,
      });
      const job = this.getJob(args.workspaceId, jobId);
      return { job, app: appDto(updatedApp) };
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.deps.db
        .update(schema.dataIngestionJobs)
        .set({
          status: 'failed',
          currentPhase: 'failed',
          progressMessage: 'Import failed',
          errorMessage: error instanceof Error ? error.message : 'Ingestion failed',
          completedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(eq(schema.dataIngestionJobs.id, jobId))
        .run();
      throw error;
    }
  }

  getJob(workspaceId: string, jobId: string) {
    const job = this.deps.db
      .select()
      .from(schema.dataIngestionJobs)
      .where(and(eq(schema.dataIngestionJobs.workspaceId, workspaceId), eq(schema.dataIngestionJobs.id, jobId)))
      .get();
    if (!job) throw new AgentisError('RESOURCE_NOT_FOUND', 'Ingestion job not found');
    return job;
  }

  removeDataset(workspaceId: string, appSlug: string, datasetKey: string) {
    const app = this.apps.getBySlug(workspaceId, appSlug);
    const contents = parseAgentisContents(app.packageContents);
    const datasetSpec = contents.datasetSpecs.find((spec) => spec.key === datasetKey);
    if (!datasetSpec) throw new AgentisError('RESOURCE_NOT_FOUND', 'Dataset spec not found');

    const knowledgeBaseIds = objectRecord(app.knowledgeBaseIds);
    const knowledgeBaseId = typeof knowledgeBaseIds[datasetKey] === 'string' ? knowledgeBaseIds[datasetKey] : null;
    if (knowledgeBaseId) {
      this.deps.db
        .delete(schema.knowledgeBases)
        .where(and(eq(schema.knowledgeBases.id, knowledgeBaseId), eq(schema.knowledgeBases.workspaceId, workspaceId)))
        .run();
      delete knowledgeBaseIds[datasetKey];
    }
    const updatedApp = this.updateDatasetStatus(app, datasetSpec, {
      status: 'not_imported',
      sourceFormat: null,
      totalItems: 0,
      processedItems: 0,
      chunkCount: 0,
      embeddingCount: 0,
      byteSize: 0,
      lastJobId: null,
      knowledgeBaseId: null,
      importedAt: null,
    }, knowledgeBaseIds);
    return appDto(updatedApp);
  }

  private ingestIntoTarget(
    app: AppInstanceRow,
    datasetSpec: DatasetSpec,
    records: NormalizedRecord[],
    args: IngestDatasetArgs,
    jobId: string,
    now: string,
  ) {
    if (datasetSpec.targetStore === 'knowledge') {
      return this.ingestIntoKnowledge(app, datasetSpec, records, args, jobId, now);
    }
    if (datasetSpec.targetStore === 'memory') {
      return this.ingestIntoMemory(app, datasetSpec, records, args, jobId, now);
    }
    return this.ingestIntoEvalExamples(app, datasetSpec, records, args, jobId, now);
  }

  private ingestIntoKnowledge(
    app: AppInstanceRow,
    datasetSpec: DatasetSpec,
    records: NormalizedRecord[],
    args: IngestDatasetArgs,
    jobId: string,
    now: string,
  ) {
    const knowledgeBaseIds = objectRecord(app.knowledgeBaseIds);
    let knowledgeBaseId = typeof knowledgeBaseIds[datasetSpec.key] === 'string' ? knowledgeBaseIds[datasetSpec.key] as string : null;
    if (!knowledgeBaseId) {
      const kb = this.deps.knowledge.createKnowledgeBase({
        workspaceId: args.workspaceId,
        name: `${app.name}: ${datasetSpec.label}`,
        description: datasetSpec.description,
      });
      knowledgeBaseId = kb.id;
      knowledgeBaseIds[datasetSpec.key] = knowledgeBaseId;
      this.deps.db
        .update(schema.appInstances)
        .set({ knowledgeBaseIds, updatedAt: now })
        .where(eq(schema.appInstances.id, app.id))
        .run();
    }

    let chunkCount = 0;
    for (const [index, record] of records.entries()) {
      const document = this.deps.knowledge.addDocument({
        workspaceId: args.workspaceId,
        knowledgeBaseId,
        name: record.title || `${datasetSpec.label} ${index + 1}`,
        mimeType: args.mimeType ?? mimeTypeFor(args.sourceFormat),
        content: record.content,
      });
      chunkCount += document.chunks;
      this.updateJobProgress(jobId, index + 1, chunkCount, chunkCount);
    }
    return { knowledgeBaseId, chunkCount, embeddingCount: chunkCount };
  }

  private ingestIntoMemory(
    app: AppInstanceRow,
    datasetSpec: DatasetSpec,
    records: NormalizedRecord[],
    args: IngestDatasetArgs,
    jobId: string,
    now: string,
  ) {
    for (const [index, record] of records.entries()) {
      this.deps.db.insert(schema.memoryEntries).values({
        id: randomUUID(),
        workspaceId: args.workspaceId,
        teamId: null,
        agentId: null,
        userId: args.userId,
        sourceType: 'app_dataset',
        sourceId: app.id,
        kind: 'dataset_record',
        title: record.title || `${datasetSpec.label} ${index + 1}`,
        content: record.content,
        importance: 5,
        confidence: 1,
        tags: ['agentis_app', app.slug, datasetSpec.key],
        metadata: { datasetKey: datasetSpec.key, jobId, fields: record.fields ?? {} },
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }).run();
      this.updateJobProgress(jobId, index + 1, index + 1, 0);
    }
    return { knowledgeBaseId: null, chunkCount: records.length, embeddingCount: 0 };
  }

  private ingestIntoEvalExamples(
    app: AppInstanceRow,
    datasetSpec: DatasetSpec,
    records: NormalizedRecord[],
    args: IngestDatasetArgs,
    jobId: string,
    now: string,
  ) {
    const suite = this.ensureEvalSuite(app, datasetSpec, args.userId, now);
    for (const [index, record] of records.entries()) {
      const fields = record.fields ?? {};
      const expected = objectRecord(fields.expected ?? fields.output ?? fields.result ?? {});
      this.deps.db.insert(schema.evalCases).values({
        id: randomUUID(),
        suiteId: suite.id,
        workspaceId: args.workspaceId,
        name: record.title || `${datasetSpec.label} ${index + 1}`,
        input: objectRecord(fields.input ?? fields.inputs ?? fields),
        expected,
        metadata: { datasetKey: datasetSpec.key, jobId, fields },
        createdAt: now,
      }).run();
      this.updateJobProgress(jobId, index + 1, index + 1, 0);
    }
    return { knowledgeBaseId: null, chunkCount: records.length, embeddingCount: 0 };
  }

  private ensureEvalSuite(app: AppInstanceRow, datasetSpec: DatasetSpec, userId: string, now: string) {
    const existing = this.deps.db
      .select()
      .from(schema.evalSuites)
      .where(and(eq(schema.evalSuites.workspaceId, app.workspaceId), eq(schema.evalSuites.appInstanceId, app.id)))
      .all()
      .find((suite) => suite.datasetKey === datasetSpec.key);
    if (existing) return existing;
    const id = randomUUID();
    this.deps.db.insert(schema.evalSuites).values({
      id,
      workspaceId: app.workspaceId,
      userId,
      appInstanceId: app.id,
      workflowId: app.entryWorkflowId,
      name: `${app.name}: ${datasetSpec.label}`,
      description: datasetSpec.description,
      datasetKey: datasetSpec.key,
      rubric: {},
      config: { source: 'dataset_import' },
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.deps.db.select().from(schema.evalSuites).where(eq(schema.evalSuites.id, id)).get()!;
  }

  private updateJobPhase(jobId: string, currentPhase: string, progressMessage: string) {
    const now = new Date().toISOString();
    this.deps.db
      .update(schema.dataIngestionJobs)
      .set({ currentPhase, progressMessage, updatedAt: now })
      .where(eq(schema.dataIngestionJobs.id, jobId))
      .run();
  }

  private updateJobProgress(jobId: string, processedItems: number, chunkCount: number, embeddingCount: number) {
    const now = new Date().toISOString();
    this.deps.db
      .update(schema.dataIngestionJobs)
      .set({ processedItems, chunkCount, embeddingCount, currentPhase: 'indexing', updatedAt: now })
      .where(eq(schema.dataIngestionJobs.id, jobId))
      .run();
  }

  private updateDatasetStatus(
    app: AppInstanceRow,
    datasetSpec: DatasetSpec,
    next: Record<string, unknown>,
    nextKnowledgeBaseIds?: Record<string, unknown>,
  ) {
    const now = new Date().toISOString();
    const statuses = Array.isArray(app.datasetStatuses)
      ? app.datasetStatuses.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const withoutCurrent = statuses.filter((item) => item.key !== datasetSpec.key);
    const status = {
      key: datasetSpec.key,
      label: datasetSpec.label,
      optional: datasetSpec.optional,
      targetStore: datasetSpec.targetStore,
      ...next,
    };
    this.deps.db
      .update(schema.appInstances)
      .set({
        datasetStatuses: [...withoutCurrent, status],
        knowledgeBaseIds: nextKnowledgeBaseIds ?? objectRecord(app.knowledgeBaseIds),
        updatedAt: now,
      })
      .where(eq(schema.appInstances.id, app.id))
      .run();
    return this.apps.getBySlug(app.workspaceId, app.slug);
  }
}

function normalizeRecords(args: IngestDatasetArgs, datasetSpec: DatasetSpec): NormalizedRecord[] {
  const format = normalizeFormat(args.sourceFormat);
  if (Array.isArray(args.records) && args.records.length > 0) {
    return applyChunkingStrategy(
      args.records.map((record, index) => recordFromObject(record, `${datasetSpec.label} ${index + 1}`, format)),
      datasetSpec,
      args.name ?? datasetSpec.label,
    );
  }
  if (Array.isArray(args.urls) && args.urls.length > 0) {
    return parseUrlList(args.urls, datasetSpec);
  }
  const content = args.content ?? '';
  if (!content.trim()) throw new AgentisError('VALIDATION_FAILED', 'Dataset content is empty');
  if (format === 'url-list') {
    return parseUrlList(content.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean), datasetSpec);
  }
  if (format === 'csv') {
    return parseCsv(content).map((record, index) => recordFromObject(record, `${datasetSpec.label} row ${index + 1}`, format));
  }
  if (format === 'json') {
    return recordsFromJsonPayload(JSON.parse(content) as unknown, datasetSpec, format);
  }
  if (format === 'jsonl') {
    return applyChunkingStrategy(content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => recordFromObject(JSON.parse(line) as unknown, `${datasetSpec.label} record ${index + 1}`, format)), datasetSpec, args.name ?? datasetSpec.label);
  }
  if (format === 'markdown' || format === 'md') {
    return parseMarkdown(content, args.name ?? datasetSpec.label, datasetSpec, format);
  }
  if (format === 'markdown-zip' || format === 'notion-export' || format === 'confluence-export' || format === 'gitbook-export') {
    return parseMarkdownExport(content, args.name ?? datasetSpec.label, datasetSpec, format);
  }
  if (format.endsWith('-export')) {
    return parseVendorExport(content, datasetSpec, format);
  }
  if (format === 'pdf') {
    return parsePdfText(content, args.name ?? datasetSpec.label, datasetSpec);
  }
  if (format === 'github-repo' || format === 'github') {
    return parseGithubPayload(content, args.name ?? datasetSpec.label, datasetSpec);
  }
  return applyChunkingStrategy([{ title: args.name ?? datasetSpec.label, content, fields: { sourceFormat: format, content } }], datasetSpec, args.name ?? datasetSpec.label);
}

function recordFromObject(value: unknown, fallbackTitle: string, sourceFormat = 'json'): NormalizedRecord {
  const fields = objectRecord(value);
  const title = ['name', 'title', 'subject', 'email', 'company', 'domain', 'path', 'file', 'url', 'id']
    .map((key) => fields[key])
    .find((item): item is string | number => typeof item === 'string' || typeof item === 'number');
  const body = ['content', 'body', 'text', 'description', 'notes', 'message', 'comment', 'code']
    .map((key) => fields[key])
    .find((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const normalizedContent = body ?? JSON.stringify(fields, null, 2);
  return {
    title: title === undefined ? fallbackTitle : String(title),
    content: normalizedContent,
    fields: { ...fields, sourceFormat, content: normalizedContent },
  };
}

function recordsFromJsonPayload(value: unknown, datasetSpec: DatasetSpec, sourceFormat: string): NormalizedRecord[] {
  const values = extractRecordArray(value);
  return applyChunkingStrategy(
    values.map((record, index) => recordFromObject(record, `${datasetSpec.label} record ${index + 1}`, sourceFormat)),
    datasetSpec,
    datasetSpec.label,
  );
}

function extractRecordArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = objectRecord(value);
  for (const key of ['records', 'items', 'data', 'contacts', 'companies', 'deals', 'tickets', 'messages', 'files', 'documents', 'issues', 'pullRequests']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [value];
}

function parseVendorExport(content: string, datasetSpec: DatasetSpec, sourceFormat: string): NormalizedRecord[] {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return recordsFromJsonPayload(JSON.parse(trimmed) as unknown, datasetSpec, sourceFormat);
  }
  return applyChunkingStrategy(
    parseCsv(content).map((record, index) => recordFromObject(normalizeVendorFields(record, sourceFormat), `${datasetSpec.label} row ${index + 1}`, sourceFormat)),
    datasetSpec,
    datasetSpec.label,
  );
}

function normalizeVendorFields(record: Record<string, string>, sourceFormat: string): Record<string, string> {
  const normalized: Record<string, string> = { ...record, sourceFormat };
  for (const [key, value] of Object.entries(record)) {
    const canonical = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (canonical && normalized[canonical] === undefined) normalized[canonical] = value;
  }
  if (sourceFormat === 'hubspot-export') normalized.crm = 'hubspot';
  if (sourceFormat === 'salesforce-export') normalized.crm = 'salesforce';
  if (sourceFormat === 'zendesk-export') normalized.support = 'zendesk';
  if (sourceFormat === 'intercom-export') normalized.support = 'intercom';
  return normalized;
}

function parseUrlList(urls: string[], datasetSpec: DatasetSpec): NormalizedRecord[] {
  return urls.map((rawUrl, index) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new AgentisError('VALIDATION_FAILED', `Invalid URL in dataset: ${rawUrl}`);
    }
    return {
      title: `${datasetSpec.label} URL ${index + 1}`,
      content: parsed.toString(),
      fields: { url: parsed.toString(), host: parsed.host, sourceFormat: 'url-list' },
    };
  });
}

function parseMarkdown(content: string, name: string, datasetSpec: DatasetSpec, sourceFormat: string): NormalizedRecord[] {
  const sections = splitMarkdownSections(content);
  const records = sections.length > 1
    ? sections.map((section, index) => markdownRecord(section, `${name} section ${index + 1}`, sourceFormat))
    : [markdownRecord(content, name, sourceFormat)];
  return applyChunkingStrategy(records, datasetSpec, name);
}

function parseMarkdownExport(content: string, name: string, datasetSpec: DatasetSpec, sourceFormat: string): NormalizedRecord[] {
  const parsed = parseMarkdownExportEnvelope(content, sourceFormat);
  if (parsed.length > 0) return applyChunkingStrategy(parsed, datasetSpec, name);
  return parseMarkdown(content, name, datasetSpec, sourceFormat);
}

function parseMarkdownExportEnvelope(content: string, sourceFormat: string): NormalizedRecord[] {
  try {
    const value = JSON.parse(content) as unknown;
    const files = extractRecordArray(value)
      .map(objectRecord)
      .filter((file) => typeof file.content === 'string' || typeof file.body === 'string' || typeof file.text === 'string');
    return files.map((file, index) => {
      const path = String(file.path ?? file.name ?? file.title ?? `document-${index + 1}.md`);
      const text = String(file.content ?? file.body ?? file.text ?? '');
      return { title: path, content: text, fields: { path, sourceFormat, content: text } };
    });
  } catch {
    return splitPseudoArchive(content).map((file) => ({
      title: file.path,
      content: file.content,
      fields: { path: file.path, sourceFormat, content: file.content },
    }));
  }
}

function splitPseudoArchive(content: string): Array<{ path: string; content: string }> {
  const marker = /^---\s*(?:file|path)?\s*:?\s*(.+?)\s*---\s*$/gim;
  const matches = [...content.matchAll(marker)];
  if (matches.length === 0) return [];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    return { path: match[1]?.trim() || `document-${index + 1}.md`, content: content.slice(start, end).trim() };
  }).filter((file) => file.content.length > 0);
}

function markdownRecord(content: string, fallbackTitle: string, sourceFormat: string): NormalizedRecord {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    title: heading || fallbackTitle,
    content: content.trim(),
    fields: { title: heading || fallbackTitle, sourceFormat, content: content.trim() },
  };
}

function splitMarkdownSections(content: string): string[] {
  const headings = [...content.matchAll(/^#\s+.+$/gm)];
  if (headings.length <= 1) return [];
  return headings.map((heading, index) => {
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? content.length;
    return content.slice(start, end).trim();
  }).filter(Boolean);
}

function parsePdfText(content: string, name: string, datasetSpec: DatasetSpec): NormalizedRecord[] {
  const extracted = content.trim().startsWith('%PDF') ? extractTextFromPdfSyntax(content) : content;
  if (!extracted.trim()) {
    throw new AgentisError('VALIDATION_FAILED', 'PDF did not contain extractable text; export it as text or markdown and import again.');
  }
  return applyChunkingStrategy([{ title: name, content: extracted, fields: { sourceFormat: 'pdf', content: extracted } }], datasetSpec, name);
}

function extractTextFromPdfSyntax(content: string): string {
  const literalStrings = [...content.matchAll(/\((?:\\.|[^\\)]){3,}\)/g)]
    .map((match) => match[0].slice(1, -1).replace(/\\([nrtbf()\\])/g, (_all, char: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[char] ?? char)))
    .filter((text) => /[A-Za-z0-9]/.test(text));
  return literalStrings.join(' ').replace(/\s+/g, ' ').trim();
}

function parseGithubPayload(content: string, name: string, datasetSpec: DatasetSpec): NormalizedRecord[] {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return recordsFromJsonPayload(JSON.parse(trimmed) as unknown, datasetSpec, 'github-repo');
  }
  return applyChunkingStrategy([{ title: name, content, fields: { sourceFormat: 'github-repo', path: name, content } }], datasetSpec, name);
}

function applyChunkingStrategy(records: NormalizedRecord[], datasetSpec: DatasetSpec, fallbackTitle: string): NormalizedRecord[] {
  if (datasetSpec.chunkingStrategy === 'sliding-window' || datasetSpec.chunkingStrategy === 'semantic') {
    return records.flatMap((record) => slidingWindowRecords(record, datasetSpec.chunkingStrategy));
  }
  if (datasetSpec.chunkingStrategy === 'per-function') {
    return records.flatMap((record) => splitCodeSymbols(record, fallbackTitle));
  }
  return records;
}

function slidingWindowRecords(record: NormalizedRecord, strategy: string): NormalizedRecord[] {
  const words = record.content.split(/\s+/).filter(Boolean);
  if (words.length <= 512) return [record];
  const chunks: NormalizedRecord[] = [];
  const step = 410;
  for (let start = 0; start < words.length; start += step) {
    const chunkIndex = chunks.length + 1;
    chunks.push({
      title: `${record.title} chunk ${chunkIndex}`,
      content: words.slice(start, start + 512).join(' '),
      fields: { ...(record.fields ?? {}), chunkIndex, chunkingStrategy: strategy },
    });
    if (start + 512 >= words.length) break;
  }
  return chunks;
}

function splitCodeSymbols(record: NormalizedRecord, fallbackTitle: string): NormalizedRecord[] {
  const symbolMatches = [...record.content.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)];
  if (symbolMatches.length === 0) return [record];
  return symbolMatches.map((match, index) => {
    const start = match.index ?? 0;
    const end = symbolMatches[index + 1]?.index ?? record.content.length;
    const name = match[1] ?? `${fallbackTitle} symbol ${index + 1}`;
    return {
      title: name,
      content: record.content.slice(start, end).trim(),
      fields: { ...(record.fields ?? {}), symbolName: name, chunkingStrategy: 'per-function' },
    };
  });
}

function assertAcceptedFormat(sourceFormat: string, datasetSpec: DatasetSpec) {
  if (datasetSpec.acceptedFormats.length === 0) return;
  const normalized = normalizeFormat(sourceFormat);
  const accepted = datasetSpec.acceptedFormats.map(normalizeFormat);
  if (!accepted.includes(normalized)) {
    throw new AgentisError('VALIDATION_FAILED', `Dataset ${datasetSpec.key} does not accept ${sourceFormat}. Accepted formats: ${datasetSpec.acceptedFormats.join(', ')}`);
  }
}

function normalizeFormat(format: string): string {
  return format.trim().toLowerCase().replace(/_/g, '-');
}

function validateRequiredFields(records: NormalizedRecord[], datasetSpec: DatasetSpec) {
  if (!datasetSpec.requiredFields?.length) return;
  const missing = new Set<string>();
  for (const record of records) {
    const fields = record.fields ?? {};
    for (const field of datasetSpec.requiredFields) {
      if (fields[field] === undefined || fields[field] === null || fields[field] === '') missing.add(field);
    }
  }
  if (missing.size > 0) {
    throw new AgentisError('VALIDATION_FAILED', `Dataset is missing required fields: ${[...missing].join(', ')}`);
  }
}

function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]!).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header || `column_${index + 1}`] = values[index] ?? '';
    });
    return record;
  });
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function mimeTypeFor(format: string): string {
  const normalized = normalizeFormat(format);
  if (normalized === 'csv' || normalized.endsWith('-export')) return 'text/csv';
  if (normalized === 'json' || normalized === 'jsonl') return 'application/json';
  if (normalized === 'pdf') return 'application/pdf';
  if (normalized.includes('markdown') || normalized === 'md') return 'text/markdown';
  return 'text/plain';
}

function sourceHash(args: Pick<IngestDatasetArgs, 'content' | 'records' | 'urls' | 'sourceFormat'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ sourceFormat: args.sourceFormat, content: args.content ?? null, records: args.records ?? null, urls: args.urls ?? null }))
    .digest('hex');
}