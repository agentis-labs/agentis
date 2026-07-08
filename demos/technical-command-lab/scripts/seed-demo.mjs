import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = process.env.AGENTIS_DEMO_BUNDLE
  ?? join(here, '..', 'bundles', 'agentis-technical-command-lab.agentis.json');

const baseUrl = (process.env.AGENTIS_URL ?? 'http://127.0.0.1:3737').replace(/\/+$/, '');
const envelope = JSON.parse(readFileSync(bundlePath, 'utf8'));

const auth = await resolveAuth();
console.log(`Agentis URL: ${baseUrl}`);
console.log(`Workspace: ${auth.workspaceId}`);
console.log(`Bundle: ${bundlePath}`);

await api('/v1/workspace/bundle/import', {
  method: 'POST',
  body: { envelope, permissionsAcknowledged: true },
});
console.log('Imported workspace bundle.');

const apps = await listApps();

for (const appManifest of envelope.manifest.apps) {
  const app = findImportedApp(apps, appManifest);
  if (!app) {
    console.warn(`Skipped hydration for ${appManifest.identity.slug}: app not found after import.`);
    continue;
  }
  for (const col of appManifest.collections) {
    for (const row of col.seed ?? []) {
      await api(`/v1/apps/${app.id}/collections/${col.name}/records`, {
        method: 'POST',
        body: { record: row },
      });
    }
  }
  await patchWorkflowBindings(app.id, appManifest.identity.slug);
  console.log(`Hydrated ${appManifest.identity.name}: collections=${appManifest.collections.length}`);
}

console.log('Technical Command Lab is ready.');
console.log('Open Agentis and start with the Command Center app.');

async function resolveAuth() {
  const apiKey = process.env.AGENTIS_API_KEY;
  const providedWorkspaceId = process.env.AGENTIS_WORKSPACE_ID;
  if (apiKey) {
    if (!providedWorkspaceId) {
      throw new Error('AGENTIS_WORKSPACE_ID is required when AGENTIS_API_KEY is used.');
    }
    return { token: apiKey, workspaceId: providedWorkspaceId };
  }

  const username = process.env.AGENTIS_USERNAME ?? 'operator';
  const password = process.env.AGENTIS_PASSWORD;
  if (!password) {
    throw new Error('Set AGENTIS_PASSWORD for login auth, or AGENTIS_API_KEY + AGENTIS_WORKSPACE_ID for API-key auth.');
  }

  const login = await raw('/v1/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  const token = login.accessToken;
  const workspaces = await raw('/v1/workspaces', {
    token,
    method: 'GET',
  });
  const workspace = providedWorkspaceId
    ? workspaces.workspaces.find((item) => item.id === providedWorkspaceId)
    : workspaces.workspaces[0];
  if (!workspace) throw new Error('No workspace found for authenticated operator.');
  return { token, workspaceId: workspace.id };
}

async function listApps() {
  const res = await api('/v1/apps', { method: 'GET' });
  return Array.isArray(res.data) ? res.data : [];
}

function findImportedApp(apps, appManifest) {
  const byExactSlug = apps.find((app) => app.slug === appManifest.identity.slug);
  const byName = apps
    .filter((app) => app.name === appManifest.identity.name)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
  return byName ?? byExactSlug;
}

async function patchWorkflowBindings(appId, slug) {
  const res = await api(`/v1/apps/${appId}/workflows`, { method: 'GET' });
  const workflows = Array.isArray(res.data) ? res.data : [];
  for (const [index, workflow] of workflows.entries()) {
    const patch = {
      order: index + 1,
      purpose: purposeFor(workflow.title),
      enabled: true,
      dependsOn: index === 0 ? [] : [workflows[index - 1].id],
      chainOn: workflow.title.toLowerCase().includes('review') || workflow.title.toLowerCase().includes('approve') ? 'always' : 'success',
      concurrency: 'exclusive',
      schedule: scheduleFor(slug, workflow.title),
    };
    await api(`/v1/apps/${appId}/workflows/${workflow.id}/binding`, {
      method: 'PATCH',
      body: patch,
    });
  }
}

function purposeFor(title) {
  const lower = title.toLowerCase();
  if (lower.includes('repo')) return 'Continuously turn repository signals into release-readiness records.';
  if (lower.includes('webhook')) return 'Show event-driven automation with operator approval before external mutation.';
  if (lower.includes('research') || lower.includes('claim')) return 'Keep claims sourced and inspectable.';
  if (lower.includes('publish') || lower.includes('launch')) return 'Prepare launch assets while gating irreversible publishing.';
  if (lower.includes('budget')) return 'Route spend through explicit operator approval.';
  return 'Coordinate the technical command workspace.';
}

function scheduleFor(slug, title) {
  if (slug === 'automation-lab' && title.toLowerCase().includes('nightly')) {
    return { cron: '0 3 * * *', enabled: true };
  }
  if (slug === 'repo-control' && title.toLowerCase().includes('nightly')) {
    return { cron: '30 3 * * *', enabled: true };
  }
  return null;
}

async function api(path, options) {
  return raw(path, { ...options, token: auth.token, workspaceId: auth.workspaceId });
}

async function raw(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.workspaceId) headers['x-agentis-workspace'] = options.workspaceId;
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} failed (${res.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}
