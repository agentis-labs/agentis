/**
 * Browser tools for the chat orchestrator + MCP surface.
 *
 * Mirrors the role-scoped `browser_*` agent tools (agentToolRuntime) so a chat
 * orchestrator — the agent that also holds `agentis.channel.send` — can open a
 * real headless browser, screenshot a page, and deliver the image, all in one
 * turn. Without this, the chat agent had no way to render or capture a page.
 */

import { AgentisError } from '@agentis/core';
import type { BrowserRenderOptions } from '../browserPool.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { shouldPersistScreenshot } from '../artifactRetentionPolicy.js';
import { runBrowserSessionAction } from '../browser/browserSessionActions.js';
import { resolveSessionOwner } from '../browser/browserSessionManager.js';
import { makeUploadMaterializer } from '../browser/uploadMaterializer.js';

export function registerBrowserTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.browser.screenshot',
        family: 'run',
        description:
          'Open a real headless browser, render a URL (or inline HTML), and capture a PNG screenshot. By default this is a transient visual check and is NOT saved to the asset library. Set `save: true` only when the user/task intentionally wants this image kept or delivered; saved captures return { artifactId, ref, url } for agentis.channel.send attachments.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Page URL to screenshot.' },
            html: { type: 'string', description: 'Inline HTML to render instead of a URL.' },
            fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default true).' },
            viewport: {
              type: 'object',
              properties: { width: { type: 'number' }, height: { type: 'number' } },
            },
            title: { type: 'string', description: 'Title for the saved artifact.' },
            save: { type: 'boolean', description: 'Persist this screenshot as a workspace asset. Default false unless the task artifact policy says to save screenshots.' },
            persist: { type: 'boolean', description: 'Alias for save.' },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const browser = requireBrowser(deps);
        const opts = browserOpts(args);
        const png = await browser.screenshot(opts);
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
        if (!deps.artifacts || !shouldPersistScreenshot(args, ctx.artifactPolicy)) {
          return { saved: false, mimeType: 'image/png', dataUrl };
        }
        const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Screenshot';
        // When the agent is operating on an App surface, file the screenshot under
        // that App so it shows in the App's "Data & Assets" library.
        const appId = ctx.appId ?? (ctx.viewport?.resourceKind === 'app' ? ctx.viewport.resourceId ?? null : null);
        const artifact = deps.artifacts.persist({
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          type: 'image',
          title,
          name: `${slugify(title)}.png`,
          content: dataUrl,
          runId: ctx.runId ?? null,
          agentId: ctx.agentId ?? null,
          appId,
          conversationId: ctx.conversationId ?? null,
          savedBy: 'agentis.browser.screenshot',
        });
        return { saved: true, artifactId: artifact.id, ref: artifact.ref, url: artifact.url, mimeType: 'image/png' };
      },
    },
    {
      definition: {
        id: 'agentis.browser.navigate',
        family: 'run',
        description: 'Open a real browser, load a URL, and return its { title, text, html }. Use for JS-rendered pages that a plain fetch cannot read.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args) => {
        const browser = requireBrowser(deps);
        const r = await browser.navigate(browserOpts(args));
        return { title: r.title, text: r.text.slice(0, 20_000), html: r.html.slice(0, 200_000) };
      },
    },
    {
      definition: {
        id: 'agentis.browser.extract_text',
        family: 'run',
        description: 'Open a real browser, load a URL (or html), and return the visible text under a CSS selector (default body).',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            html: { type: 'string' },
            selector: { type: 'string' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args) => {
        const browser = requireBrowser(deps);
        const text = await browser.extractText(browserOpts(args));
        return { text: text.slice(0, 50_000) };
      },
    },
    {
      definition: {
        id: 'agentis.browser.extract_table',
        family: 'run',
        description: 'Open a real browser and parse an HTML <table> into an array of row objects. args: { url?, html?, selector? }.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' }, html: { type: 'string' }, selector: { type: 'string' } },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args) => {
        const browser = requireBrowser(deps);
        const rows = await browser.extractTable(browserOpts(args));
        return { rows, count: rows.length };
      },
    },
    {
      definition: {
        id: 'agentis.browser.fill_form',
        family: 'run',
        description: 'Open a real browser, fill form fields by CSS selector, optionally submit, and return read-back values + final HTML. args: { url?, html?, formData: { [selector]: value }, submitSelector? }.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            html: { type: 'string' },
            formData: { type: 'object', description: 'Map of CSS selector → value.' },
            submitSelector: { type: 'string' },
          },
          required: ['formData'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args) => {
        const browser = requireBrowser(deps);
        const opts = browserOpts(args);
        if (args.formData && typeof args.formData === 'object' && !Array.isArray(args.formData)) {
          opts.formData = args.formData as Record<string, string>;
        } else {
          throw new AgentisError('VALIDATION_FAILED', 'agentis.browser.fill_form requires a formData object');
        }
        if (typeof args.submitSelector === 'string') opts.submitSelector = args.submitSelector;
        const r = await browser.fillForm(opts);
        return { title: r.title, values: r.values, html: r.html.slice(0, 200_000) };
      },
    },
    {
      definition: {
        id: 'agentis.browser.session',
        family: 'run',
        description:
          'Drive a PERSISTENT browser session that survives across calls — log in once, then act as the logged-in user on later calls (unlike the one-shot agentis.browser.* tools). First call action:"open" with a sessionId (optionally restoreAuth to reuse saved cookies); later calls reuse that sessionId and return a compact { snapshot:{url,title,text}, value? }. actions: open|navigate|click|fill|type|press|select_option|hover|scroll|wait_for|get|upload|evaluate|save_auth|close. On open: visible:true pops up a real WATCHABLE window on the host machine; attach:"chrome" drives the user\'s OWN running Chrome (real logins; they must launch Chrome with --remote-debugging-port=9222). upload attaches workspace assetRefs to a file input. Call save_auth with authName to persist login for future runs.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            sessionId: { type: 'string' },
            visible: { type: 'boolean', description: 'On open: pop up a real watchable browser window (local host only).' },
            attach: { type: 'string', enum: ['chrome'], description: 'On open: attach to the user\'s running Chrome via CDP (real profile/logins).' },
            profileName: { type: 'string', description: 'On open (visible): persistent profile name so logins survive across runs.' },
            url: { type: 'string' },
            selector: { type: 'string' },
            value: { type: 'string' },
            text: { type: 'string' },
            key: { type: 'string' },
            what: { type: 'string', enum: ['text', 'value', 'attribute', 'innerHTML'] },
            attribute: { type: 'string' },
            restoreAuth: { type: 'string' },
            authName: { type: 'string' },
            expression: { type: 'string' },
            assetRefs: { type: 'array', items: { type: 'string' }, description: 'For action:"upload" — workspace asset/artifact refs to attach to a file input.' },
          },
          required: ['action', 'sessionId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const manager = requireSessions(deps);
        const owner = resolveSessionOwner({ runId: ctx.runId, conversationId: ctx.conversationId, agentId: ctx.agentId });
        if (!owner) throw new AgentisError('VALIDATION_FAILED', 'browser session requires a run, agent, or conversation context');
        return runBrowserSessionAction(args, {
          manager,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId ?? null,
          owner,
          ...(deps.artifacts ? { materializeUploads: makeUploadMaterializer(deps.artifacts, ctx.workspaceId) } : {}),
        });
      },
    },
  ]);
}

function requireBrowser(deps: ToolHandlerDeps) {
  if (!deps.browserPool) throw new AgentisError('VALIDATION_FAILED', 'browser runtime is not wired (Playwright unavailable)');
  return deps.browserPool;
}

function requireSessions(deps: ToolHandlerDeps) {
  if (!deps.browserSessions) throw new AgentisError('VALIDATION_FAILED', 'persistent browser sessions are not wired (Playwright unavailable)');
  return deps.browserSessions;
}

function browserOpts(args: Record<string, unknown>): BrowserRenderOptions {
  const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
  const html = typeof args.html === 'string' && args.html ? args.html : undefined;
  if (!url && !html) throw new AgentisError('VALIDATION_FAILED', 'browser tool requires a `url` or `html` argument');
  const out: BrowserRenderOptions = {};
  if (url) out.url = url;
  if (html) out.html = html;
  if (typeof args.selector === 'string' && args.selector.trim()) out.selector = args.selector.trim();
  if (typeof args.fullPage === 'boolean') out.fullPage = args.fullPage;
  const vp = args.viewport;
  if (vp && typeof vp === 'object' && !Array.isArray(vp)) {
    const v = vp as { width?: unknown; height?: unknown };
    if (typeof v.width === 'number' && typeof v.height === 'number') out.viewport = { width: v.width, height: v.height };
  }
  return out;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'screenshot';
}
