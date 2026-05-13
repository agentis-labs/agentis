import {
  agentisPackageContentsSchema,
  packageManifestSchema,
  type AgentisPackageContents,
  type DatasetSpec,
  type PackageExportEnvelope,
  type PackageManifest,
  type WorkflowGraph,
} from '@agentis/core';
import { createHash } from 'node:crypto';

export type AgentisAppDefinition = Omit<AgentisPackageContents, 'kind'> & { kind?: 'agentis' };

export interface BuildManifestOptions {
  slug: string;
  name: string;
  version?: string;
  description?: string | null;
  tags?: string[];
  agentisVersion?: string;
  author?: PackageManifest['author'];
}

export function defineAgentisApp(definition: AgentisAppDefinition): AgentisPackageContents {
  return agentisPackageContentsSchema.parse({ kind: 'agentis', ...definition });
}

export function defineDataset(spec: DatasetSpec): DatasetSpec {
  return spec;
}

export function defineWorkflow(args: {
  title: string;
  slug?: string;
  summary?: string | null;
  graph: WorkflowGraph;
  settings?: Record<string, unknown>;
  maxConcurrentRuns?: number | null;
  concurrencyOverflow?: 'queue' | 'reject' | 'replace_oldest' | null;
}) {
  return args;
}

export function buildPackageManifest(contents: AgentisPackageContents, options: BuildManifestOptions): PackageManifest {
  const checksum = sha256(stableJson(contents));
  return packageManifestSchema.parse({
    manifestVersion: 1,
    agentisVersion: options.agentisVersion ?? '1.0.0',
    slug: options.slug,
    name: options.name,
    version: options.version ?? '1.0.0',
    kind: 'agentis',
    description: options.description ?? null,
    tags: options.tags ?? [],
    contents,
    checksum,
    source: null,
    remoteId: null,
    author: options.author ?? null,
  });
}

export function buildExportEnvelope(contents: AgentisPackageContents, options: BuildManifestOptions): PackageExportEnvelope {
  const manifest = buildPackageManifest(contents, options);
  return {
    packageManifest: manifest,
    agentisVersion: manifest.agentisVersion,
    exportedAt: new Date().toISOString(),
  };
}

export interface AgentisClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export function createAgentisClient(options: AgentisClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3737').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`Agentis API ${res.status}: ${await res.text()}`);
    return await res.json() as T;
  }
  return {
    listApps: () => request('/v1/apps'),
    activatePackage: (packageId: string) => request(`/v1/apps/activate/${encodeURIComponent(packageId)}`, { method: 'POST' }),
    importPackage: (manifest: PackageManifest | PackageExportEnvelope) => request('/v1/packages/import', {
      method: 'POST',
      body: JSON.stringify(manifest),
    }),
    runEvalSuite: (suiteId: string, syncTimeoutMs?: number) => request(`/v1/evals/${encodeURIComponent(suiteId)}/run`, {
      method: 'POST',
      body: JSON.stringify({ syncTimeoutMs }),
    }),
    evaluatePolicy: (body: Record<string, unknown>) => request('/v1/policies/evaluate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  };
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}