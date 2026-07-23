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
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { AgentisError } from '@agentis/core';
import type { Logger } from '../logger.js';
import { assertSafeUrl } from './safeUrl.js';

// ── Minimal Playwright shim (only what we use) ──────────────────────────────
// Exported so the session layer (browserSession.ts) types against the same
// minimal shape and `tsc` never needs the real `playwright` types resolved.
export interface PWPage {
  route(pattern: string, handler: (route: PWRoute) => Promise<void>): Promise<void>;
  setContent(html: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  screenshot(opts?: { fullPage?: boolean; type?: 'png' | 'jpeg' }): Promise<Buffer>;
  pdf(opts?: { printBackground?: boolean; format?: string }): Promise<Buffer>;
  url(): string;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
  content(): Promise<string>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
  type(selector: string, text: string, opts?: { delay?: number; timeout?: number }): Promise<void>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  hover(selector: string, opts?: { timeout?: number }): Promise<void>;
  selectOption(selector: string, values: string | string[], opts?: { timeout?: number }): Promise<string[]>;
  setInputFiles(selector: string, files: string | string[], opts?: { timeout?: number }): Promise<void>;
  getAttribute(selector: string, name: string, opts?: { timeout?: number }): Promise<string | null>;
  inputValue(selector: string, opts?: { timeout?: number }): Promise<string>;
  innerHTML(selector: string, opts?: { timeout?: number }): Promise<string>;
  waitForSelector(selector: string, opts?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<unknown>;
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(timeout: number): Promise<void>;
  keyboard: { press(key: string, opts?: { delay?: number }): Promise<void> };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  evaluate<T = unknown, A = unknown>(expression: string | ((arg: A) => T | Promise<T>), arg?: A): Promise<T>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  emulateMedia(opts: { media?: 'screen' | 'print' }): Promise<void>;
  close(): Promise<void>;
}
interface PWRoute {
  request(): { url(): string };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
/** Playwright `StorageState` — cookies + per-origin localStorage. Opaque to us. */
export type PWStorageState = Record<string, unknown>;
export interface PWContext {
  newPage(): Promise<PWPage>;
  storageState(): Promise<PWStorageState>;
  close(): Promise<void>;
}

/** Normalized session surface — a live page plus mode-specific close/persist behavior. */
export interface SessionSurface {
  page: PWPage;
  storageState: () => Promise<PWStorageState>;
  /** Mode-aware teardown: closes our context/window, or (attach) only the tab. */
  close: () => Promise<void>;
}
interface PWBrowser {
  newPage(): Promise<PWPage>;
  newContext(opts?: { storageState?: PWStorageState; viewport?: { width: number; height: number } | null }): Promise<PWContext>;
  contexts(): PWContext[];
  close(): Promise<void>;
  isConnected(): boolean;
}
interface PWChromium {
  launch(opts?: { headless?: boolean }): Promise<PWBrowser>;
  /** Headed, persistent-profile launch — returns a context directly (no separate browser). */
  launchPersistentContext(userDataDir: string, opts?: { headless?: boolean; channel?: string }): Promise<PWContext>;
  /** Attach to an already-running Chrome exposing a CDP endpoint (e.g. --remote-debugging-port). */
  connectOverCDP(endpoint: string): Promise<PWBrowser>;
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
  /** For fill_form: selector → value. */
  formData?: Record<string, string>;
  /** For fill_form: optional element to click after filling (submit). */
  submitSelector?: string;
  /**
   * Run-scoped cancellation: aborting closes the page, so an in-flight
   * navigation/screenshot rejects immediately instead of holding the node
   * (and the run) open until its timeout.
   */
  signal?: AbortSignal;
}

export class BrowserPool {
  #pw: PWModule | null = null;
  #browser: PWBrowser | null = null;
  #ready: Promise<void> | null = null;
  #install: Promise<void> | null = null;
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];
  /** Headed persistent contexts we launched — closed on shutdown (they own a visible window). */
  readonly #headedContexts = new Set<PWContext>();
  /** CDP-attached browsers (user's real Chrome) — NEVER closed by us on shutdown. */
  readonly #attachedBrowsers = new Set<PWBrowser>();
  readonly #profilesDir: string;

  constructor(private readonly logger: Logger, opts?: { profilesDir?: string }) {
    this.#limit = resolveConcurrency();
    this.#profilesDir = opts?.profilesDir ?? join(process.cwd(), '.agentis', 'browser-profiles');
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
    return this.#withPage(opts, async (page) => {
      await this.#applyViewport(page, opts.viewport);
      await this.#load_(page, opts);
      return page.screenshot({ fullPage: opts.fullPage ?? true, type: 'png' });
    });
  }

  /** Render a URL or inline HTML to PDF bytes. */
  async pdf(opts: BrowserRenderOptions): Promise<Buffer> {
    return this.#withPage({ headless: true, signal: opts.signal }, async (page) => {
      await this.#load_(page, opts);
      await page.emulateMedia({ media: 'print' });
      return page.pdf({ printBackground: true, format: 'A4' });
    });
  }

  /** Navigate to a URL and return its title + visible text + final HTML. */
  async navigate(opts: BrowserRenderOptions): Promise<{ title: string; text: string; html: string }> {
    return this.#withPage(opts, async (page) => {
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
    return this.#withPage(opts, async (page) => {
      await this.#load_(page, opts);
      return page.innerText(opts.selector ?? 'body').catch(() => '');
    });
  }

  /** Fill form fields by selector, optionally submit; returns read-back values + final HTML. */
  async fillForm(opts: BrowserRenderOptions): Promise<{ title: string; html: string; values: Record<string, string> }> {
    return this.#withPage(opts, async (page) => {
      await this.#load_(page, opts);
      const selectors = Object.keys(opts.formData ?? {});
      for (const selector of selectors) {
        await page.fill(selector, (opts.formData ?? {})[selector]!);
      }
      if (opts.submitSelector) await page.click(opts.submitSelector);
      // Read back live `.value` (the value attribute in serialized HTML does not
      // reflect typed input, so we evaluate the live property).
      const values: Record<string, string> = {};
      for (const selector of selectors) {
        const v = await page.evaluate<string, string>(
          (fieldSelector) => {
            const el = document.querySelector(fieldSelector);
            const value = el && 'value' in el ? (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value : '';
            return String(value ?? '');
          },
          selector,
        );
        values[selector] = typeof v === 'string' ? v : '';
      }
      const [title, html] = await Promise.all([page.title(), page.content()]);
      return { title, html, values };
    });
  }

  /** Extract a `<table>` (by selector, default first) into an array of row objects. */
  async extractTable(opts: BrowserRenderOptions): Promise<Array<Record<string, string | null>>> {
    return this.#withPage(opts, async (page) => {
      await this.#load_(page, opts);
      const rows = await page.evaluate<Array<Record<string, string | null>>, string>(
        (selector) => {
          const table = document.querySelector(selector);
          if (!table) return [];
          const rows = Array.from(table.querySelectorAll('tr'));
          const headerRow = rows[0];
          if (!headerRow) return [];
          const headers = Array.from(headerRow.querySelectorAll('th,td')).map((c) => (c.textContent || '').trim());
          const out: Array<Record<string, string | null>> = [];
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row) continue;
            const cells = Array.from(row.querySelectorAll('td,th')).map((c) => (c.textContent || '').trim());
            const obj: Record<string, string | null> = {};
            headers.forEach((h, idx) => { obj[h || ('col' + idx)] = cells[idx] ?? null; });
            out.push(obj);
          }
          return out;
        },
        opts.selector ?? 'table',
      );
      return Array.isArray(rows) ? rows : [];
    });
  }

  async shutdown(): Promise<void> {
    // Close headed windows we launched…
    for (const ctx of this.#headedContexts) await ctx.close().catch(() => {});
    this.#headedContexts.clear();
    // …but NEVER close a CDP-attached browser — that is the user's real Chrome.
    this.#attachedBrowsers.clear();
    if (this.#browser) {
      await this.#browser.close().catch(() => {});
      this.#browser = null;
    }
  }

  // ── Session-support surface (used by BrowserSessionManager) ────────────────
  // These expose the pool's SSRF guard + concurrency budget so persistent
  // sessions reuse the exact same safety logic as one-shot ops instead of
  // duplicating it. A session holds its own BrowserContext (isolated cookies),
  // but every Chromium *operation* still runs through `withConcurrencySlot`.

  /**
   * Create a fresh isolated BrowserContext (own cookies/localStorage) off the
   * shared headless browser, optionally seeded with a saved `storageState`
   * ("log in once, reuse"). The caller owns closing the context.
   */
  async newSessionContext(opts: { storageState?: PWStorageState; viewport?: { width: number; height: number } } = {}): Promise<PWContext> {
    await this.ensureReady();
    const browser = await this.#sharedBrowser();
    return browser.newContext({
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
      ...(opts.viewport ? { viewport: opts.viewport } : {}),
    });
  }

  /**
   * Open a session surface for one of three modes and return a normalized
   * lifecycle so the session layer never branches on mode internals:
   *   - `headless` (default): invisible isolated context off the shared browser.
   *   - `visible`: a REAL, watchable window (persistent Chrome profile) — pops up
   *     on the machine running the API. Requires a display (local only).
   *   - `attach`: the user's OWN running Chrome over CDP — real profile + logins,
   *     seen in their own window. Close touches ONLY the tab we opened.
   * The page is SSRF-guarded in every mode.
   */
  async openSessionSurface(opts: {
    mode?: 'headless' | 'visible' | 'attach';
    storageState?: PWStorageState;
    viewport?: { width: number; height: number };
    profileName?: string;
    /** Explicit allow decision for `attach` (resolved from the Settings opt-in). Undefined → fall back to the env master. */
    allowCdp?: boolean;
  } = {}): Promise<SessionSurface> {
    const mode = opts.mode ?? 'headless';
    if (mode === 'visible') return this.#openVisibleSurface(opts);
    if (mode === 'attach') return this.#openAttachSurface(opts.allowCdp);
    // headless (default)
    const context = await this.newSessionContext({
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
      ...(opts.viewport ? { viewport: opts.viewport } : {}),
    });
    const page = await context.newPage();
    await this.guardPage(page);
    return { page, storageState: () => context.storageState(), close: () => context.close() };
  }

  async #openVisibleSurface(opts: { profileName?: string; viewport?: { width: number; height: number } }): Promise<SessionSurface> {
    if (!browserHeadedAllowed()) {
      throw new AgentisError('BROWSER_OPERATION_FAILED', 'visible browser is disabled (set AGENTIS_BROWSER_ALLOW_HEADED=true; requires a local display)');
    }
    await this.ensureReady();
    const profile = sanitizeProfile(opts.profileName);
    const dir = join(this.#profilesDir, profile);
    // Prefer the user's real Chrome for fidelity; fall back to bundled Chromium.
    const context = await this.#launchPersistent(dir).catch((err) => {
      throw new AgentisError('BROWSER_OPERATION_FAILED', `could not open a visible browser window: ${(err as Error).message} (a local display is required)`);
    });
    this.#headedContexts.add(context);
    const page = await context.newPage();
    await this.guardPage(page);
    const close = async () => { this.#headedContexts.delete(context); await context.close().catch(() => {}); };
    return { page, storageState: () => context.storageState(), close };
  }

  async #launchPersistent(dir: string): Promise<PWContext> {
    await this.#load();
    try {
      const ctx = await this.#pw!.chromium.launchPersistentContext(dir, { headless: false, channel: 'chrome' });
      this.logger.info('browser.session.visible_launched', { channel: 'chrome', dir });
      return ctx;
    } catch (err) {
      // Chrome not installed → bundled Chromium (still a visible window).
      this.logger.info('browser.session.visible_fallback_chromium', { reason: (err as Error).message });
      const ctx = await this.#pw!.chromium.launchPersistentContext(dir, { headless: false });
      this.logger.info('browser.session.visible_launched', { channel: 'chromium', dir });
      return ctx;
    }
  }

  async #openAttachSurface(allowCdpOverride?: boolean): Promise<SessionSurface> {
    // The Settings opt-in (resolved upstream) wins; absent that, the env master.
    const allowed = allowCdpOverride ?? browserCdpAllowed();
    if (!allowed) {
      throw new AgentisError('BROWSER_OPERATION_FAILED', 'attaching to your real Chrome is disabled — enable it in Settings → Governance ("Let agents control my real Chrome")');
    }
    await this.#load();
    const endpoint = chromeCdpUrl();
    let browser: PWBrowser;
    try {
      browser = await this.#pw!.chromium.connectOverCDP(endpoint);
    } catch (err) {
      throw new AgentisError(
        'BROWSER_OPERATION_FAILED',
        `could not reach your Chrome at ${endpoint}. Start Chrome once with:  chrome --remote-debugging-port=9222   (${(err as Error).message})`,
      );
    }
    this.#attachedBrowsers.add(browser);
    // Reuse the user's real default context (their logins/cookies), else make one.
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    await this.guardPage(page);
    // CLOSE-SAFETY: only close the tab we opened — never the context or the
    // user's browser. The CDP client disconnects when the process exits.
    const close = async () => { await page.close().catch(() => {}); };
    return { page, storageState: () => context.storageState(), close };
  }

  /** Apply the SSRF request guard to a session-owned page (same as one-shot ops). */
  async guardPage(page: PWPage): Promise<void> {
    return this.#guardNetworkRequests(page);
  }

  /** Validate + normalize a navigation URL against the SSRF policy. Throws on block. */
  async resolveSafeNavUrl(raw: string): Promise<string> {
    const url = await assertSafeUrl(raw, { allowPrivate: browserPrivateNetworkAllowed() });
    return url.toString();
  }

  /**
   * Run a single Chromium operation inside the shared concurrency budget, so a
   * long-lived session never permanently holds a slot — it acquires one only
   * for the duration of one primitive, then releases.
   */
  async withConcurrencySlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }


  async #withPage<T>(
    opts: { headless?: boolean; signal?: AbortSignal },
    fn: (page: PWPage) => Promise<T>,
  ): Promise<T> {
    if (opts.signal?.aborted) {
      throw new AgentisError('BROWSER_OPERATION_FAILED', 'browser op cancelled before it started (run aborted)');
    }
    await this.#acquire();
    let page: PWPage | null = null;
    let ephemeral: PWBrowser | null = null;
    // Cancellation: closing the page makes every in-flight Playwright call
    // (goto/screenshot/pdf/…) reject immediately — the only reliable way to
    // interrupt Chromium work mid-operation.
    const onAbort = () => {
      if (page) void page.close().catch(() => {});
      if (ephemeral) void ephemeral.close().catch(() => {});
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.ensureReady();
      let browser: PWBrowser;
      if (opts.headless === false) {
        // Visible window: a dedicated browser we don't pool.
        ephemeral = await this.#pw!.chromium.launch({ headless: false });
        browser = ephemeral;
      } else {
        browser = await this.#sharedBrowser();
      }
      page = await browser.newPage();
      if (opts.signal?.aborted) {
        throw new Error('run aborted');
      }
      await this.#guardNetworkRequests(page);
      return await fn(page);
    } catch (err) {
      if (opts.signal?.aborted) {
        throw new AgentisError('BROWSER_OPERATION_FAILED', 'browser op cancelled (run aborted)');
      }
      throw new AgentisError('BROWSER_OPERATION_FAILED', `browser op failed: ${(err as Error).message}`);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
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
      const url = await assertSafeUrl(opts.url, { allowPrivate: browserPrivateNetworkAllowed() });
      await page.goto(url.toString(), { waitUntil: 'networkidle', timeout });
    } else {
      throw new Error('browser op requires either html or url');
    }
  }

  async #guardNetworkRequests(page: PWPage): Promise<void> {
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:')) {
        await route.continue();
        return;
      }
      try {
        await assertSafeUrl(url, { allowPrivate: browserPrivateNetworkAllowed() });
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
  }

  /** Ensure Playwright is loaded and Chromium is installed (single-flight). */
  async ensureReady(): Promise<void> {
    if (!this.#ready) this.#ready = this.#initialize();
    return this.#ready;
  }

  async #initialize(): Promise<void> {
    await this.#load();
    if (this.#chromiumInstalled()) {
      try {
        const probe = await this.#pw!.chromium.launch({ headless: true });
        await probe.close();
        return;
      } catch {
        // A partial Playwright cache can contain the full Chrome executable but
        // not the headless shell. Run the idempotent installer to repair it.
      }
    }
    await this.#installChromium();
    const probe = await this.#pw!.chromium.launch({ headless: true });
    await probe.close();
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
          { timeout: 900_000, windowsHide: true },
          (error, _stdout, stderr) => {
            if (error) {
              this.logger.error('browser.chromium.install_failed', { err: error.message, stderr: String(stderr).slice(-500) });
              const detail = String(stderr).trim().split('\n').slice(-3).join(' ').slice(-500);
              reject(new AgentisError(
                'BROWSER_OPERATION_FAILED',
                `Chromium install failed: ${error.message}${detail ? ` (${detail})` : ''}`,
              ));
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

function browserPrivateNetworkAllowed(): boolean {
  return String(process.env.AGENTIS_BROWSER_ALLOW_PRIVATE ?? '').toLowerCase() === 'true';
}

/** Visible (headed) windows are allowed by default; only meaningful on a machine with a display. */
function browserHeadedAllowed(): boolean {
  return String(process.env.AGENTIS_BROWSER_ALLOW_HEADED ?? 'true').toLowerCase() !== 'false';
}

/** Attaching to the user's real Chrome (CDP) is OFF by default — it lets the agent act as logged-in you. */
function browserCdpAllowed(): boolean {
  return String(process.env.AGENTIS_BROWSER_ALLOW_CDP ?? '').toLowerCase() === 'true';
}

function chromeCdpUrl(): string {
  const raw = String(process.env.AGENTIS_CHROME_CDP_URL ?? '').trim();
  return raw || 'http://localhost:9222';
}

/** A safe on-disk profile folder name (no traversal / separators). */
function sanitizeProfile(name?: string): string {
  const base = (name ?? 'default').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return base.slice(0, 48) || 'default';
}

/** Resolve the Playwright CLI entrypoint for the on-demand install. */
function requireResolveCli(): string {
  const req = createRequire(import.meta.url);
  const packageJson = req.resolve('playwright/package.json');
  return join(dirname(packageJson), 'cli.js');
}
