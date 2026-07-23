/**
 * Shared `browser_session` action dispatcher — the single place that maps loose
 * tool args → a {@link BrowserSessionManager} / {@link BrowserSession} call.
 *
 * Both the role-scoped agent tool (`browser_session` in agentToolRuntime) and the
 * MCP tool (`agentis.browser.session`) forward here, so the action grammar lives
 * once (feedback: never duplicate — extend). Upload path resolution is injected
 * by the caller because only it knows how to turn workspace asset refs into
 * validated local paths (arbitrary-FS-read guard, BROWSERPOOL-10X §7).
 */

import { AgentisError } from '@agentis/core';
import type { BrowserSessionManager, SessionOwner } from './browserSessionManager.js';
import type { MaterializedUploads } from './uploadMaterializer.js';

export interface SessionActionCtx {
  manager: BrowserSessionManager;
  workspaceId: string;
  userId: string | null;
  owner: SessionOwner;
  signal?: AbortSignal;
  /** Materialize workspace asset refs → temp files for `upload` (with cleanup). Absent → upload unsupported here. */
  materializeUploads?: (assetRefs: string[]) => Promise<MaterializedUploads>;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (!v) throw new AgentisError('VALIDATION_FAILED', `browser_session ${key} is required`);
  return v;
}

function viewportOf(args: Record<string, unknown>): { width: number; height: number } | undefined {
  const vp = args.viewport;
  if (vp && typeof vp === 'object' && !Array.isArray(vp)) {
    const v = vp as { width?: unknown; height?: unknown };
    if (typeof v.width === 'number' && typeof v.height === 'number') return { width: v.width, height: v.height };
  }
  return undefined;
}

export async function runBrowserSessionAction(args: Record<string, unknown>, ctx: SessionActionCtx): Promise<unknown> {
  const action = requireStr(args, 'action');
  const sessionId = requireStr(args, 'sessionId');
  const { manager, workspaceId, owner } = ctx;

  switch (action) {
    case 'open': {
      // visible → a watchable pop-up window; attach:"chrome" → the user's own
      // running Chrome (real logins). Default is headless/invisible. Accept the
      // flags loosely (models sometimes serialize booleans as strings).
      const isTruthy = (v: unknown) => v === true || String(v).toLowerCase() === 'true';
      const mode = isTruthy(args.attach) || String(args.attach ?? '').toLowerCase() === 'chrome'
        ? 'attach'
        : isTruthy(args.visible) ? 'visible' : 'headless';
      const session = await manager.openSession({
        workspaceId,
        owner,
        sessionId,
        mode,
        ...(str(args, 'profileName') ? { profileName: str(args, 'profileName')! } : {}),
        ...(str(args, 'restoreAuth') ? { restoreAuthName: str(args, 'restoreAuth')! } : {}),
        ...(viewportOf(args) ? { viewport: viewportOf(args)! } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      // Convenience: `open` may carry an initial url so the agent lands somewhere in one call.
      const url = str(args, 'url');
      if (url) return { opened: true, sessionId, mode, ...(await session.navigate(url)) };
      return { opened: true, sessionId, mode };
    }
    case 'close':
      await manager.closeSession(workspaceId, owner, sessionId);
      return { closed: true, sessionId };
    case 'save_auth':
      await manager.saveAuthState(workspaceId, ctx.userId, owner, sessionId, requireStr(args, 'authName'));
      return { saved: true, sessionId, authName: str(args, 'authName') };
    default:
      break;
  }

  // All remaining actions operate on an already-open session.
  const session = manager.getSession(workspaceId, owner, sessionId);
  switch (action) {
    case 'navigate':
      return session.navigate(requireStr(args, 'url'));
    case 'click':
      return session.click(requireStr(args, 'selector'));
    case 'fill':
      return session.fill(requireStr(args, 'selector'), requireStr(args, 'value'));
    case 'type':
      return session.type(requireStr(args, 'selector'), requireStr(args, 'text'), typeof args.delay === 'number' ? args.delay : undefined);
    case 'press':
      return session.press(requireStr(args, 'key'), str(args, 'selector'));
    case 'select_option': {
      const value = args.value;
      const values = Array.isArray(value) ? value.map(String) : requireStr(args, 'value');
      return session.selectOption(requireStr(args, 'selector'), values);
    }
    case 'hover':
      return session.hover(requireStr(args, 'selector'));
    case 'scroll':
      return session.scroll({
        ...(typeof args.dx === 'number' ? { dx: args.dx } : {}),
        ...(typeof args.dy === 'number' ? { dy: args.dy } : {}),
        ...(args.toBottom === true ? { toBottom: true } : {}),
      });
    case 'wait_for':
      return session.waitFor({
        ...(str(args, 'selector') ? { selector: str(args, 'selector')! } : {}),
        ...(str(args, 'state') ? { state: str(args, 'state') as 'attached' | 'detached' | 'visible' | 'hidden' } : {}),
        ...(args.navigation === true ? { navigation: true } : {}),
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
      });
    case 'get':
      return session.get({
        selector: requireStr(args, 'selector'),
        what: (str(args, 'what') ?? 'text') as 'text' | 'value' | 'attribute' | 'innerHTML',
        ...(str(args, 'attribute') ? { attribute: str(args, 'attribute')! } : {}),
      });
    case 'upload': {
      if (!ctx.materializeUploads) {
        throw new AgentisError('VALIDATION_FAILED', 'browser_session upload is not supported on this surface');
      }
      const refs = Array.isArray(args.assetRefs) ? args.assetRefs.map(String) : [];
      const { paths, cleanup } = await ctx.materializeUploads(refs);
      try {
        return await session.upload(requireStr(args, 'selector'), paths);
      } finally {
        await cleanup();
      }
    }
    case 'evaluate':
      return session.evaluate(requireStr(args, 'expression'));
    default:
      throw new AgentisError('VALIDATION_FAILED', `browser_session: unknown action "${action}"`);
  }
}
