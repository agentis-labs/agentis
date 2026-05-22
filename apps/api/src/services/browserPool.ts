/**
 * BrowserPool — native Playwright runtime for the `browser` node
 * (WORKFLOW-10X-MASTERPLAN §3.2, "Native-first principle").
 *
 * We own webpage screenshots / HTML→PDF / rendering instead of calling an
 * external service. Playwright runs headless Chromium in this process, capped at
 * AGENTIS_BROWSER_CONCURRENCY (default 3) via a small semaphore.
 *
 * On-demand install: `playwright` is a declared dependency, but the Chromium
 * binary is a separate ~150MB download. `ensureReady()` lazily imports the
 * module and, if the Chromium binary is missing, installs it once (single-flight)
 * via the Playwright CLI. Machines that already have it pay nothing.
 *
 * Typecheck is decoupled from Playwright being installed: the module is imported
 * through a non-literal specifier and typed against a minimal local shim, so
 * `tsc` never needs `@types`/`playwright` resolved on a fresh checkout.
 */

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { AgentisError } from '@agentis/core';
import type { Logger } from '../logger.js';

// ── Minimal Playwright shim (only what we use) ──────────────────────────────
interface PWPage {
  setContent(html: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  screenshot(opts?: { fullPage?: boolean; type?: 'png' | 'jpeg' }): Promise<Buffer>;
  pdf(opts?: { printBackground?: boolean; format?: string }): Promise<Buffer>;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
  content(): Promise<string>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  emulateMedia(opts: { media?: 'screen' | 'print' }): Promise<void>;
  close(): Promise<void>;
}
interface PWBrowser {
  newPage(): Promise<PWPage>;
  close(): Promise<void>;
  isConnected(): boolean;
}
interface PWChromium {
  launch(opts?: { headless?: boolean }): Promise<PWBrowser>;
  executablePath(): string;
}
interface PWModule { chromium: PWChromium; }

export interface BrowserRenderOptions {
  url?: string;
  html?: string;
  selector?: string;
  fullPage?: boolean;
  headless?: boolean;
  viewport?: { width: number; height: number };
  timeout?: number;
}

export class BrowserPool {
  #pw: PWModule | null = null;
  #browser: PWBrowser | null = null;
  #ready: Promise<void> | null = null;
  #install: Promise<void> | null = null;
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(private readonly logger: Logger) {
    this.#limit = resolveConcurrency();
  }

  /** Whether Playwright can be loaded at all (module installed). */
  async available(): Promise<boolean> {
    try {
      await this.#load();
      return true;
    } catch {
      return false;
    }
  }

  /** Full-page (configurable) screenshot of a URL or inline HTML → PNG bytes. */
  async screenshot(opts: BrowserRenderOptions): Promise<Buffer> {
    return this.#withPage(opts.headless, async (page) => {
      await this.#applyViewport(page, opts.viewport);
      await this.#load_(page, opts);
      return page.screenshot({ fullPage: opts.fullPage ?? true, type: 'png' });
    });
  }

  /** Render a URL or inline HTML to PDF bytes. */
  async pdf(opts: BrowserRenderOptions): Promise<Buffer> {
    return this.#withPage(true, async (page) => {
      await this.#load_(page, opts);
      await page.emulateMedia({ media: 'print' });
      return page.pdf({ printBackground: true, format: 'A4' });
    });
  }

  /** Navigate to a URL and return its title + visible text + final HTML. */
  async navigate(opts: BrowserRenderOptions): Promise<{ title: string; text: string; html: string }> {
    return this.#withPage(opts.headless, async (page) => {
      await this.#load_(page, opts);
      const [title, text, html] = await Promise.all([
        page.title(),
        page.innerText('body').catch(() => ''),
        page.content(),
      ]);
      return { title, text, html };
    });
  }

  /** Extract visible text under a selector (or whole body). */
  async extractText(opts: BrowserRenderOptions): Promise<string> {
    return this.#withPage(opts.headless, async (page) => {
      await this.#load_(page, opts);
      return page.innerText(opts.selector ?? 'body').catch(() => '');
    });
  }

  async shutdown(): Promise<void> {
    if (this.#browser) {
      await this.#browser.close().catch(() => {});
      this.#browser = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  async #withPage<T>(headless: boolean | undefined, fn: (page: PWPage) => Promise<T>): Promise<T> {
    await this.#acquire();
    let page: PWPage | null = null;
    let ephemeral: PWBrowser | null = null;
    try {
      await this.ensureReady();
      let browser: PWBrowser;
      if (headless === false) {
        // Visible window: a dedicated browser we don't pool.
        ephemeral = await this.#pw!.chromium.launch({ headless: false });
        browser = ephemeral;
      } else {
        browser = await this.#sharedBrowser();
      }
      page = await browser.newPage();
      return await fn(page);
    } catch (err) {
      throw new AgentisError('BROWSER_OPERATION_FAILED', `browser op failed: ${(err as Error).message}`);
    } finally {
      if (page) await page.close().catch(() => {});
      if (ephemeral) await ephemeral.close().catch(() => {});
      this.#release();
    }
  }

  async #sharedBrowser(): Promise<PWBrowser> {
    if (this.#browser && this.#browser.isConnected()) return this.#browser;
    this.#browser = await this.#pw!.chromium.launch({ headless: true });
    return this.#browser;
  }

  async #applyViewport(page: PWPage, viewport?: { width: number; height: number }): Promise<void> {
    if (viewport) await page.setViewportSize(viewport).catch(() => {});
  }

  /** Load either inline HTML or a URL into the page. */
  async #load_(page: PWPage, opts: BrowserRenderOptions): Promise<void> {
    const timeout = Math.max(1_000, Math.min(opts.timeout ?? 30_000, 120_000));
    if (opts.html != null) {
      await page.setContent(opts.html, { waitUntil: 'networkidle', timeout });
    } else if (opts.url) {
      await page.goto(opts.url, { waitUntil: 'networkidle', timeout });
    } else {
      throw new Error('browser op requires either html or url');
    }
  }

  /** Ensure Playwright is loaded and Chromium is installed (single-flight). */
  async ensureReady(): Promise<void> {
    if (!this.#ready) this.#ready = this.#initialize();
    return this.#ready;
  }

  async #initialize(): Promise<void> {
    await this.#load();
    if (!this.#chromiumInstalled()) {
      await this.#installChromium();
    }
  }

  async #load(): Promise<PWModule> {
    if (this.#pw) return this.#pw;
    try {
      // Non-literal specifier keeps `tsc` from requiring playwright at build time.
      const spec = 'playwright';
      const mod = (await import(spec)) as unknown as PWModule;
      this.#pw = mod;
      return mod;
    } catch (err) {
      throw new AgentisError(
        'BROWSER_OPERATION_FAILED',
        `Playwright is not installed. Run "pnpm --filter @agentis/api add playwright". (${(err as Error).message})`,
      );
    }
  }

  #chromiumInstalled(): boolean {
    try {
      const p = this.#pw!.chromium.executablePath();
      return Boolean(p) && existsSync(p);
    } catch {
      return false;
    }
  }

  /** Install the Chromium binary on demand, once. */
  async #installChromium(): Promise<void> {
    if (!this.#install) {
      this.logger.info('browser.chromium.installing', {});
      this.#install = new Promise<void>((resolve, reject) => {
        // Use the Playwright CLI shipped with the installed package.
        execFile(
          process.execPath,
          [requireResolveCli(), 'install', 'chromium'],
          { timeout: 300_000 },
          (error, _stdout, stderr) => {
            if (error) {
              this.logger.error('browser.chromium.install_failed', { err: error.message, stderr: String(stderr).slice(-500) });
              reject(new AgentisError('BROWSER_OPERATION_FAILED', `Chromium install failed: ${error.message}`));
              return;
            }
            this.logger.info('browser.chromium.installed', {});
            resolve();
          },
        );
      });
    }
    return this.#install;
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  #release(): void {
    this.#active -= 1;
    const next = this.#waiters.shift();
    if (next) next();
  }
}

function resolveConcurrency(): number {
  const raw = Number(process.env.AGENTIS_BROWSER_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 16) : 3;
}

/** Resolve the Playwright CLI entrypoint for the on-demand install. */
function requireResolveCli(): string {
  // playwright's package exposes cli.js; resolve from the installed package.
  const req = createRequire(import.meta.url);
  try {
    return req.resolve('playwright/cli.js');
  } catch {
    // Fallback: playwright-core ships the cli too.
    return req.resolve('playwright-core/cli.js');
  }
}
