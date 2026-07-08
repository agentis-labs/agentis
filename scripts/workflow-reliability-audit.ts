#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SurfaceCheck {
  label: string;
  path: string;
  exists: boolean;
  pairedTestPath?: string;
  pairedTestExists?: boolean;
}

interface CoverageRow {
  kind: string;
  mentions: number;
  hasCoverage: boolean;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const agentisRoot = repoRoot;
const writeReport = process.argv.includes('--write');
const jsonMode = process.argv.includes('--json');
const reportPath = resolve(repoRoot, 'docs', 'reports', 'workflow-reliability-audit.md');

function resolveN8nRoot(): string {
  const candidates = [
    process.env.N8N_REPO_DIR,
    resolve(repoRoot, '..', 'n8n'),
    resolve(repoRoot, '..', '..', 'n8n'),
    resolve(repoRoot, '..', '..', '..', 'n8n'),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => exists(resolve(candidate, 'packages')));
  return found ? resolve(found) : resolve(candidates[0]!);
}

const n8nRoot = resolveN8nRoot();

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function exists(path: string): boolean {
  return existsSync(path);
}

function walk(dir: string, predicate: (path: string) => boolean, out: string[] = []): string[] {
  if (!exists(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, predicate, out);
      continue;
    }
    if (predicate(full)) out.push(full);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractQuotedUnion(content: string, anchor: RegExp): string[] {
  const match = content.match(anchor);
  if (!match) return [];
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((entry) => entry[1]!);
}

function countMentions(haystack: string, needle: string): number {
  const patterns = [
    new RegExp(`'${escapeRegExp(needle)}'`, 'g'),
    new RegExp(`"${escapeRegExp(needle)}"`, 'g'),
  ];
  return patterns.reduce((sum, pattern) => sum + (haystack.match(pattern)?.length ?? 0), 0);
}

function buildSurfaceChecks(): SurfaceCheck[] {
  const surfaces: Array<{ label: string; path: string; pairedTestPath?: string }> = [
    {
      label: 'Workflow engine',
      path: 'apps/api/src/engine/WorkflowEngine.ts',
      pairedTestPath: 'apps/api/tests/engine/WorkflowEngine.newNodes.test.ts',
    },
    {
      label: 'Trigger runtime',
      path: 'apps/api/src/engine/TriggerRuntime.ts',
      pairedTestPath: 'apps/api/tests/services/triggerRuntime.test.ts',
    },
    {
      label: 'Listener runtime',
      path: 'apps/api/src/engine/ListenerRuntime.ts',
      pairedTestPath: 'apps/api/tests/engine/ListenerRuntime.test.ts',
    },
    {
      label: 'Graph validation boundary',
      path: 'apps/api/src/engine/validateGraph.ts',
      pairedTestPath: 'apps/api/tests/validateGraph.test.ts',
    },
    {
      label: 'Reference lint',
      path: 'apps/api/src/engine/validateGraphReferences.ts',
      pairedTestPath: 'apps/api/tests/engine/validateGraphReferences.test.ts',
    },
    {
      label: 'Graph normalization',
      path: 'apps/api/src/services/workflowGraphNormalization.ts',
      pairedTestPath: 'apps/api/tests/services/workflowGraphNormalization.test.ts',
    },
    {
      label: 'Workflow readiness',
      path: 'apps/api/src/services/workflowReadiness.ts',
      pairedTestPath: 'apps/api/tests/services/workflowReadiness.test.ts',
    },
    {
      label: 'Trigger deployment',
      path: 'apps/api/src/services/workflowTriggerDeployment.ts',
      pairedTestPath: 'apps/api/tests/services/workflowTriggerDeployment.test.ts',
    },
    {
      label: 'Extension runtime',
      path: 'apps/api/src/services/extensionRuntime.ts',
      pairedTestPath: 'apps/api/tests/services/extensionRuntime.test.ts',
    },
  ];
  return surfaces.map((surface) => {
    const fullPath = resolve(agentisRoot, surface.path);
    const testPath = surface.pairedTestPath ? resolve(agentisRoot, surface.pairedTestPath) : undefined;
    return {
      label: surface.label,
      path: surface.path,
      exists: exists(fullPath),
      pairedTestPath: surface.pairedTestPath,
      pairedTestExists: testPath ? exists(testPath) : undefined,
    };
  });
}

function renderMarkdown(params: {
  generatedAt: string;
  nodeCoverage: CoverageRow[];
  triggerCoverage: CoverageRow[];
  testFileCount: number;
  surfaceChecks: SurfaceCheck[];
  n8nPackages: string[];
  n8nNodeDirCount: number | null;
  n8nCoreFiles: string[];
  missingNodeCoverage: string[];
  missingTriggerCoverage: string[];
}): string {
  const lines: string[] = [];
  lines.push('# Workflow Reliability Audit');
  lines.push('');
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push('');
  lines.push('## Agentis Surface');
  lines.push('');
  lines.push(`- API test files scanned: ${params.testFileCount}`);
  lines.push(`- Workflow node kinds: ${params.nodeCoverage.length}`);
  lines.push(`- Trigger kinds: ${params.triggerCoverage.length}`);
  lines.push('');
  lines.push('### Node Coverage');
  lines.push('');
  lines.push('| Node kind | Test mentions | Covered |');
  lines.push('| --- | ---: | --- |');
  for (const row of params.nodeCoverage) {
    lines.push(`| \`${row.kind}\` | ${row.mentions} | ${row.hasCoverage ? 'yes' : 'no'} |`);
  }
  lines.push('');
  lines.push('### Trigger Coverage');
  lines.push('');
  lines.push('| Trigger kind | Test mentions | Covered |');
  lines.push('| --- | ---: | --- |');
  for (const row of params.triggerCoverage) {
    lines.push(`| \`${row.kind}\` | ${row.mentions} | ${row.hasCoverage ? 'yes' : 'no'} |`);
  }
  lines.push('');
  lines.push('### Critical Surfaces');
  lines.push('');
  lines.push('| Surface | Source | Source present | Paired test | Test present |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const surface of params.surfaceChecks) {
    lines.push(`| ${surface.label} | \`${surface.path}\` | ${surface.exists ? 'yes' : 'no'} | ${surface.pairedTestPath ? `\`${surface.pairedTestPath}\`` : ''} | ${surface.pairedTestExists === undefined ? '' : surface.pairedTestExists ? 'yes' : 'no'} |`);
  }
  lines.push('');
  lines.push('## n8n Reference');
  lines.push('');
  lines.push(`- packages discovered: ${params.n8nPackages.join(', ') || 'not found'}`);
  lines.push(`- nodes-base directories counted: ${params.n8nNodeDirCount ?? 'not found'}`);
  lines.push('');
  lines.push('### n8n Core Files');
  lines.push('');
  for (const file of params.n8nCoreFiles) {
    lines.push(`- \`${file}\``);
  }
  lines.push('');
  lines.push('## Reliability Backlog Seeds');
  lines.push('');
  lines.push(`- Node kinds without direct API test mentions: ${params.missingNodeCoverage.length > 0 ? params.missingNodeCoverage.map((item) => `\`${item}\``).join(', ') : 'none'}`);
  lines.push(`- Trigger kinds without direct API test mentions: ${params.missingTriggerCoverage.length > 0 ? params.missingTriggerCoverage.map((item) => `\`${item}\``).join(', ') : 'none'}`);
  lines.push('- Use this report to drive the next hardening wave before adding new workflow features.');
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const workflowTypes = read(resolve(agentisRoot, 'packages/core/src/types/workflow.ts'));
  const nodeKinds = extractQuotedUnion(
    workflowTypes,
    /export type WorkflowNodeType\s*=\s*([\s\S]*?);/m,
  );
  const triggerKinds = extractQuotedUnion(
    workflowTypes,
    /triggerType:\s*([\s\S]*?);/m,
  );

  const apiTestFiles = walk(resolve(agentisRoot, 'apps/api/tests'), (path) => path.endsWith('.test.ts'));
  const combinedTests = apiTestFiles.map((path) => read(path)).join('\n');
  const nodeCoverage = nodeKinds.map((kind) => {
    const mentions = countMentions(combinedTests, kind);
    return { kind, mentions, hasCoverage: mentions > 0 };
  });
  const triggerCoverage = triggerKinds.map((kind) => {
    const mentions = countMentions(combinedTests, kind);
    return { kind, mentions, hasCoverage: mentions > 0 };
  });
  const surfaceChecks = buildSurfaceChecks();

  const n8nPackagesDir = resolve(n8nRoot, 'packages');
  const n8nPackages = exists(n8nPackagesDir)
    ? readdirSync(n8nPackagesDir).filter((entry) => statSync(join(n8nPackagesDir, entry)).isDirectory())
    : [];
  const n8nNodesDir = resolve(n8nRoot, 'packages/nodes-base/nodes');
  const n8nNodeDirCount = exists(n8nNodesDir)
    ? readdirSync(n8nNodesDir).filter((entry) => statSync(join(n8nNodesDir, entry)).isDirectory()).length
    : null;
  const n8nCoreFiles = [
    'packages/core/src/execution-engine/workflow-execute.ts',
    'packages/core/src/execution-engine/active-workflows.ts',
    'packages/core/src/execution-engine/execution-lifecycle-hooks.ts',
    'packages/core/src/execution-engine/scheduled-task-manager.ts',
    'packages/workflow/src/run-execution-data/run-execution-data.v1.ts',
    'packages/workflow/src/interfaces.ts',
  ].filter((relativePath) => exists(resolve(n8nRoot, relativePath)));

  const report = renderMarkdown({
    generatedAt: new Date().toISOString(),
    nodeCoverage,
    triggerCoverage,
    testFileCount: apiTestFiles.length,
    surfaceChecks,
    n8nPackages,
    n8nNodeDirCount,
    n8nCoreFiles,
    missingNodeCoverage: nodeCoverage.filter((row) => !row.hasCoverage).map((row) => row.kind),
    missingTriggerCoverage: triggerCoverage.filter((row) => !row.hasCoverage).map((row) => row.kind),
  });

  if (writeReport) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report, 'utf8');
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      nodeCoverage,
      triggerCoverage,
      testFileCount: apiTestFiles.length,
      surfaceChecks,
      n8nPackages,
      n8nNodeDirCount,
      n8nCoreFiles,
    }, null, 2));
    process.stdout.write('\n');
    return;
  }

  process.stdout.write(report);
}

main();
