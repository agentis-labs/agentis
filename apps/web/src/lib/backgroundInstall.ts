/**
 * backgroundInstall — singleton store for background runtime installs.
 *
 * When a user commissions an agent whose runtime is not yet installed,
 * the wizard closes immediately and the install runs here in the background.
 * Components (fleet canvas card, quick-detail panel) subscribe to live progress.
 *
 * Architecture:
 *  - Module-level Map<agentId, InstallSession> for zero-dependency reactivity.
 *  - Pub/sub via a Set of listener callbacks (React components use useSyncExternalStore).
 *  - SSE fetch to POST /v1/harness/install streams step/log events.
 *  - On complete: PATCHes the agent config with the discovered binaryPath, then cleans up.
 */

import { api, apiErrorMessage, streamSse } from './api';

// ─── Types ──────────────────────────────────────────────────────────────────

export type InstallStep = {
  index: number;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
};

export type InstallPhase = 'installing' | 'verifying' | 'complete' | 'error';

export interface InstallSession {
  agentId: string;
  agentName: string;
  adapterType: string;
  phase: InstallPhase;
  steps: InstallStep[];
  logs: string[];
  error?: string;
  startedAt: number;
  completedAt?: number;
  result?: {
    binaryPath?: string;
    detectedVersion?: string;
    detectedModel?: string;
  };
}

// ─── Store ──────────────────────────────────────────────────────────────────

const sessions = new Map<string, InstallSession>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function getInstallSession(agentId: string): InstallSession | undefined {
  return sessions.get(agentId);
}

export function getAllInstallSessions(): InstallSession[] {
  return Array.from(sessions.values());
}

export function hasActiveInstall(agentId: string): boolean {
  const s = sessions.get(agentId);
  return s?.phase === 'installing' || s?.phase === 'verifying';
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React 18 useSyncExternalStore compatible snapshot. */
let snapshotVersion = 0;
export function getSnapshot(): number {
  return snapshotVersion;
}

function bump() {
  snapshotVersion++;
  emit();
}

function emitInstallLifecycle(agentId: string, phase: InstallPhase) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('agentis:background-install-updated', {
    detail: { agentId, phase },
  }));
}

// ─── Actions ────────────────────────────────────────────────────────────────

export interface StartBackgroundInstallOpts {
  agentId: string;
  agentName: string;
  adapterType: 'claude_code' | 'codex';
  adapterConfig: Record<string, unknown>;
  runtimeModel?: string | null;
}

/**
 * Kicks off a background install for the given agent.
 * Does NOT block — returns immediately. Progress is observable via the store.
 */
export function startBackgroundInstall(opts: StartBackgroundInstallOpts): void {
  if (hasActiveInstall(opts.agentId)) return;

  const session: InstallSession = {
    agentId: opts.agentId,
    agentName: opts.agentName,
    adapterType: opts.adapterType,
    phase: 'installing',
    steps: [],
    logs: [],
    startedAt: Date.now(),
  };
  sessions.set(opts.agentId, session);
  bump();

  void runInstallStream(opts, session);
}

export function dismissInstallSession(agentId: string): void {
  sessions.delete(agentId);
  bump();
}

// ─── SSE Stream Consumer ────────────────────────────────────────────────────

async function runInstallStream(opts: StartBackgroundInstallOpts, session: InstallSession) {
  try {
    await streamSse('/v1/harness/install', {
      method: 'POST',
      body: JSON.stringify({ adapterType: opts.adapterType }),
    }, {
      onEvent: (event, payload) => handleSSEEvent(session, event, payload),
    });

    if (session.phase === 'error') {
      await updateAgentStatus(opts.agentId, 'error');
      emitInstallLifecycle(opts.agentId, 'error');
      return;
    }

    // If we exited the stream without a complete/error event, mark as done
    if (session.phase === 'installing' || session.phase === 'verifying') {
      session.phase = 'complete';
      session.completedAt = Date.now();
    }
    bump();

    // PATCH the agent with the discovered binary path
    if (session.result?.binaryPath) {
      try {
        await api(`/v1/agents/${opts.agentId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            config: { ...opts.adapterConfig, binaryPath: session.result.binaryPath },
            runtimeModel: opts.runtimeModel ?? session.result.detectedModel ?? null,
            status: 'online',
          }),
        });
        emitInstallLifecycle(opts.agentId, 'complete');
      } catch {
        // Best-effort — agent still created, user can fix config later
      }
    } else if (session.phase === 'complete') {
      // Even without a binaryPath, re-register with the adapter config; the API
      // will validate PATH and reject if the runtime still cannot be found.
      try {
        await api(`/v1/agents/${opts.agentId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            config: opts.adapterConfig,
            runtimeModel: opts.runtimeModel ?? session.result?.detectedModel ?? null,
            status: 'online',
          }),
        });
        emitInstallLifecycle(opts.agentId, 'complete');
      } catch {
        session.phase = 'error';
        session.error = 'Runtime installed, but Agentis could not connect it automatically.';
        await updateAgentStatus(opts.agentId, 'error').catch(() => {});
        emitInstallLifecycle(opts.agentId, 'error');
      }
    }

    bump();
  } catch (err) {
    session.phase = 'error';
    session.error = apiErrorMessage(err);
    try {
      await updateAgentStatus(opts.agentId, 'error');
      emitInstallLifecycle(opts.agentId, 'error');
    } catch {
      // best-effort
    }
    bump();
  }
}

async function updateAgentStatus(agentId: string, status: 'online' | 'error') {
  await api(`/v1/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

function handleSSEEvent(session: InstallSession, event: string, payload: unknown) {
  try {
    if (event === 'step') {
      const step = payload as InstallStep;
      const existing = session.steps.findIndex((s) => s.index === step.index);
      if (existing >= 0) {
        session.steps[existing] = step;
      } else {
        session.steps.push(step);
      }
      if (step.index === 3 && step.status === 'running') {
        session.phase = 'verifying';
      }
      bump();
    } else if (event === 'log') {
      const line = payload && typeof payload === 'object' && typeof (payload as { line?: unknown }).line === 'string'
        ? (payload as { line: string }).line
        : '';
      if (line) {
        session.logs.push(line);
        // Keep last 200 log lines to avoid memory bloat
        if (session.logs.length > 200) session.logs.splice(0, session.logs.length - 200);
      }
      bump();
    } else if (event === 'complete') {
      session.phase = 'complete';
      session.completedAt = Date.now();
      session.result = payload as InstallSession['result'];
      bump();
    } else if (event === 'error') {
      session.phase = 'error';
      session.error = payload && typeof payload === 'object' && typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : 'Install failed';
      bump();
    }
  } catch {
    // Malformed SSE data — skip
  }
}
