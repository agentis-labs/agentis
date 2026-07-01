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

export function registerBrowserTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.browser.screenshot',
        family: 'run',
        description:
          'Open a real headless browser, render a URL (or inline HTML), and capture a PNG screenshot saved as an artifact. Returns { artifactId, ref, url }. Chat automatically renders the saved artifact; to deliver the image to Telegram/WhatsApp/Slack/Discord, pass `ref` (e.g. "artifact:<id>") to agentis.channel.send `attachments`.',
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
        if (!deps.artifacts) return { saved: false, mimeType: 'image/png', dataUrl };
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
  ]);
}

function requireBrowser(deps: ToolHandlerDeps) {
  if (!deps.browserPool) throw new AgentisError('VALIDATION_FAILED', 'browser runtime is not wired (Playwright unavailable)');
  return deps.browserPool;
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
