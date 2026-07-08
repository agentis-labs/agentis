#!/usr/bin/env node
/**
 * File-size budget check (pre-launch modularity DNA).
 *
 * Per docs/PRE-LAUNCH-ARCHITECTURAL-AUDIT.md §2.1: soft cap 600 LOC, hard cap
 * 1000. A NEW file over the hard cap fails the build. The files already over it
 * are tracked debt in ALLOWLIST (with the decomposition owner in the audit) — the
 * point of this check is to stop the bleeding, not to block on existing debt.
 * Generated files (db schema/migrations) are exempt.
 *
 * Usage: node scripts/check-file-budget.mjs [--warn]  (--warn also lists soft-cap files)
 * Exit 1 if any non-allowlisted file exceeds the hard cap.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asPosix = (p) => p.split(sep).join('/');
const SOFT = 600, HARD = 1000;

// Generated / vendored — not hand-authored, exempt from the budget.
const EXEMPT = [
  'packages/db/src/sqlite/schema.ts',
  'packages/db/src/sqlite/migrations.ts',
];

// Existing files over the hard cap at the time the budget was introduced
// (2026-07-07). Tracked debt — do not add to this list; shrink it.
const ALLOWLIST = new Set([
  'apps/api/src/engine/WorkflowEngine.ts',
  'apps/api/src/services/agentisToolHandlers/build.ts',
  'apps/api/src/services/sharedIntelligence.ts',
  'apps/api/src/services/chat/chatSessionExecutor.ts',
  'apps/api/src/bootstrap.ts',
  'apps/api/src/engine/selfHeal/selfHealController.ts',
  'apps/api/src/routes/conversations.ts',
  'apps/api/src/services/chat/chatToolCatalog.ts',
  'apps/api/src/adapters/HermesAgentAdapter.ts',
  'apps/api/src/services/agent/agentSessionRuntime.ts',
  'apps/api/src/services/datasetIngestion.ts',
  'apps/api/src/routes/apps.ts',
  'apps/api/src/services/conversation/channelBridge.ts',
  'apps/api/src/services/conversation/channelTurnDispatcher.ts',
  'apps/api/src/routes/workflows.ts',
  'apps/api/src/services/knowledge/knowledgeBase.ts',
  'packages/core/src/types/workflow.ts',
  'apps/web/src/components/home/WorkspaceEcosystemCanvas.tsx',
  'apps/web/src/pages/WorkflowCanvasPage.tsx',
  'apps/web/src/components/canvas/ContextInspector.tsx',
  'apps/web/src/components/apps/ViewRenderer.tsx',
  'apps/web/src/components/chat/ThreadView.tsx',
  'apps/web/src/components/brain/PersonalBrainPanel.tsx',
  'apps/web/src/pages/AppEditorPage.tsx',
  'apps/web/src/pages/PackagesPage.tsx',
  'apps/web/src/components/canvas/WorkflowMonitorCard.tsx',
  'apps/web/src/components/agents/AgentCreateWizard.tsx',
  'apps/web/src/components/runs/RunModalProvider.tsx',
  'apps/web/src/components/settings/SettingsModal.tsx',
]);

function collect(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' ||
        e.name === '.agentis' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}
const isTest = (p) => /(^|\/)tests?\//.test(p) || /\.(test|spec)\.(ts|tsx)$/.test(p);

const roots = ['apps/api/src', 'apps/web/src', ...['core','db','integrations','app','cli','sdk','runtime','app-client'].map(p => `packages/${p}/src`)];
const overHard = [], overSoft = [];
for (const r of roots) {
  for (const f of collect(join(ROOT, r))) {
    const rel = asPosix(relative(ROOT, f));
    if (isTest(rel) || EXEMPT.includes(rel)) continue;
    const loc = readFileSync(f, 'utf8').split('\n').length;
    if (loc > HARD && !ALLOWLIST.has(rel)) overHard.push({ rel, loc });
    else if (loc > SOFT && loc <= HARD) overSoft.push({ rel, loc });
  }
}

if (process.argv.includes('--warn') && overSoft.length) {
  console.log(`ℹ ${overSoft.length} file(s) over the ${SOFT}-LOC soft cap (consider splitting):`);
  for (const { rel, loc } of overSoft.sort((a, b) => b.loc - a.loc)) console.log(`    ${loc}  ${rel}`);
}
if (overHard.length === 0) {
  console.log(`✓ file-budget: no NEW file over the ${HARD}-LOC hard cap (${ALLOWLIST.size} tracked-debt files allowlisted)`);
  process.exit(0);
}
console.error(`✗ file-budget: ${overHard.length} NEW file(s) exceed the ${HARD}-LOC hard cap — split them or justify + allowlist:\n`);
for (const { rel, loc } of overHard.sort((a, b) => b.loc - a.loc)) console.error(`    ${loc}  ${rel}`);
process.exit(1);
