/**
 * BrowserSession — one persistent, isolated browser context + live page that
 * SURVIVES across separate tool calls (BROWSERPOOL-10X §Design).
 *
 * The whole reason this exists: one-shot ops (`BrowserPool.screenshot/navigate/…`)
 * open a fresh page and close it, so an agent can never "log in, then act as the
 * logged-in user on the next call." A session keeps one `BrowserContext` (its own
 * cookies/localStorage) and one `Page` alive between calls, exposing fine-grained
 * interaction primitives (click/type/upload/wait/…) on that live page.
 *
 * Safety is inherited from the pool, never duplicated: navigation goes through
 * `pool.resolveSafeNavUrl` (SSRF policy) and the page is guarded by
 * `pool.guardPage` (every request re-validated). Every Chromium operation runs
 * inside `pool.withConcurrencySlot` so a long-lived session consumes a slot only
 * for the duration of a single primitive — never permanently. A per-session
 * mutex serializes ops so the agent never races two actions on one page.
 */

import { AgentisError } from '@agentis/core';
import type { BrowserPool, PWPage, PWStorageState } from '../browserPool.js';

/** Mode-specific teardown/persist behavior injected by the manager (see BrowserPool.openSessionSurface). */
export interface SessionLifecycle {
  close: () => Promise<void>;
  storageState: () => Promise<PWStorageState>;
}

/** Compact page state returned after every primitive so the agent can reason about the next step. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Visible <body> text, truncated — enough to orient, not a full DOM dump. */
  text: string;
}

export interface InteractionResult {
  snapshot: PageSnapshot;
  /** Present for read ops (`get`, `select_option`) — the requested value(s). */
  value?: string | string[];
}

/** Bounded per-op timeout for session primitives — below the 120s one-shot max so a blocking wait can't starve one-shot ops. */
const SESSION_OP_TIMEOUT_MS = 30_000;
const SNAPSHOT_TEXT_CHARS = 2_000;
const MAX_EVAL_EXPRESSION = 20_000;
const MAX_EVAL_RESULT_CHARS = 20_000;

function boundTimeout(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, SESSION_OP_TIMEOUT_MS) : SESSION_OP_TIMEOUT_MS;
}

function evaluateAllowed(): boolean {
  return String(process.env.AGENTIS_BROWSER_ALLOW_EVALUATE ?? '').toLowerCase() === 'true';
}

export class BrowserSession {
  #lastUsedAt: number;
  #closing = false;
  #lock: Promise<void> = Promise.resolve();

  constructor(
    readonly key: string,
    readonly workspaceId: string,
    readonly sessionId: string,
    private readonly pool: BrowserPool,
    private readonly page: PWPage,
    private readonly lifecycle: SessionLifecycle,
    now: number,
  ) {
    this.#lastUsedAt = now;
  }

  get lastUsedAt(): number {
    return this.#lastUsedAt;
  }

  /** Current page URL — cheap (sync), used for per-turn session awareness. */
  currentUrl(): string {
    try {
      return this.page.url();
    } catch {
      return '';
    }
  }

  get isClosing(): boolean {
    return this.#closing;
  }

  // ── Primitives (each returns a fresh snapshot; snapshot attached even on error) ──

  /** Load a URL in the live page. SSRF-guarded. */
  navigate(url: string): Promise<InteractionResult> {
    return this.#op(async (page) => {
      const safe = await this.pool.resolveSafeNavUrl(url);
      await page.goto(safe, { waitUntil: 'networkidle', timeout: SESSION_OP_TIMEOUT_MS });
      return {};
    });
  }

  click(selector: string): Promise<InteractionResult> {
    return this.#op(async (page) => {
      await page.click(this.#sel(selector), { timeout: SESSION_OP_TIMEOUT_MS });
      return {};
    });
  }

  fill(selector: string, value: string): Promise<InteractionResult> {
    return this.#op(async (page) => {
      await page.fill(this.#sel(selector), String(value ?? ''), { timeout: SESSION_OP_TIMEOUT_MS });
      return {};
    });
  }

  type(selector: string, text: string, delay?: number): Promise<InteractionResult> {
    return this.#op(async (page) => {
      await page.type(this.#sel(selector), String(text ?? ''), {
        timeout: SESSION_OP_TIMEOUT_MS,
        ...(typeof delay === 'number' && delay > 0 ? { delay: Math.min(delay, 500) } : {}),
      });
      return {};
    });
  }

  press(key: string, selector?: string): Promise<InteractionResult> {
    return this.#op(async (page) => {
      if (typeof selector === 'string' && selector.trim()) {
        await page.click(this.#sel(selector), { timeout: SESSION_OP_TIMEOUT_MS });
      }
      await page.keyboard.press(this.#requireStr(key, 'key'));
      return {};
    });
  }

  selectOption(selector: string, values: string | string[]): Promise<InteractionResult> {
    return this.#op(async (page) => {
      const selected = await page.selectOption(this.#sel(selector), values, { timeout: SESSION_OP_TIMEOUT_MS });
      return { value: selected };
    });
  }

  hover(selector: string): Promise<InteractionResult> {
    return this.#op(async (page) => {
      await page.hover(this.#sel(selector), { timeout: SESSION_OP_TIMEOUT_MS });
      return {};
    });
  }

  scroll(opts: { dx?: number; dy?: number; toBottom?: boolean }): Promise<InteractionResult> {
    return this.#op(async (page) => {
      if (opts.toBottom) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      } else {
        await page.mouse.wheel(Number(opts.dx ?? 0) || 0, Number(opts.dy ?? 600) || 0);
      }
      return {};
    });
  }

  waitFor(opts: { selector?: string; state?: 'attached' | 'detached' | 'visible' | 'hidden'; navigation?: boolean; timeoutMs?: number }): Promise<InteractionResult> {
    const timeout = boundTimeout(opts.timeoutMs);
    return this.#op(async (page) => {
      if (opts.selector && opts.selector.trim()) {
        await page.waitForSelector(opts.selector.trim(), { state: opts.state ?? 'visible', timeout });
      } else if (opts.navigation) {
        await page.waitForLoadState('networkidle', { timeout });
      } else {
        await page.waitForTimeout(timeout);
      }
      return {};
    }, opts.selector);
  }

  get(opts: { selector: string; what: 'text' | 'value' | 'attribute' | 'innerHTML'; attribute?: string }): Promise<InteractionResult> {
    const selector = this.#sel(opts.selector);
    return this.#op(async (page) => {
      let value: string;
      switch (opts.what) {
        case 'text':
          value = await page.innerText(selector);
          break;
        case 'value':
          value = await page.inputValue(selector, { timeout: SESSION_OP_TIMEOUT_MS });
          break;
        case 'attribute':
          value = (await page.getAttribute(selector, this.#requireStr(opts.attribute, 'attribute'), { timeout: SESSION_OP_TIMEOUT_MS })) ?? '';
          break;
        case 'innerHTML':
          value = await page.innerHTML(selector, { timeout: SESSION_OP_TIMEOUT_MS });
          break;
        default:
          throw new AgentisError('VALIDATION_FAILED', `browser session get: unknown what "${String(opts.what)}"`);
      }
      return { value: value.slice(0, MAX_EVAL_RESULT_CHARS) };
    });
  }

  /**
   * Set files on a file input. Paths MUST already be validated/resolved by the
   * caller (tool dispatch) — the session never accepts raw agent-supplied FS
   * paths to avoid arbitrary-read (BROWSERPOOL-10X §7).
   */
  upload(selector: string, filePaths: string[]): Promise<InteractionResult> {
    return this.#op(async (page) => {
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        throw new AgentisError('VALIDATION_FAILED', 'browser session upload requires resolved file path(s)');
      }
      await page.setInputFiles(this.#sel(selector), filePaths, { timeout: SESSION_OP_TIMEOUT_MS });
      return {};
    });
  }

  /**
   * Evaluate an expression in the PAGE context (never Node — no FS/process
   * access). Gated behind AGENTIS_BROWSER_ALLOW_EVALUATE; expression + result
   * size are capped. Residual page-origin fetch is already bounded by the route
   * guard (private ranges blocked).
   */
  evaluate(expression: string): Promise<InteractionResult> {
    return this.#op(async (page) => {
      if (!evaluateAllowed()) {
        throw new AgentisError('VALIDATION_FAILED', 'browser session evaluate is disabled (set AGENTIS_BROWSER_ALLOW_EVALUATE=true to enable)');
      }
      const expr = this.#requireStr(expression, 'expression');
      if (expr.length > MAX_EVAL_EXPRESSION) {
        throw new AgentisError('VALIDATION_FAILED', `browser session evaluate expression too long (>${MAX_EVAL_EXPRESSION} chars)`);
      }
      const raw = await page.evaluate<unknown, string>((code) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (${code})`);
        return fn();
      }, expr);
      let value: string;
      try {
        value = typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch {
        value = String(raw);
      }
      return { value: (value ?? '').slice(0, MAX_EVAL_RESULT_CHARS) };
    });
  }

  /** Serialize this session's live context (cookies + localStorage) for the auth store. */
  async exportStorageState(): Promise<PWStorageState> {
    return this.#withMutex(() => this.pool.withConcurrencySlot(() => this.lifecycle.storageState()));
  }

  /** Tear down per the session's mode. Idempotent; safe from reaper/abort/shutdown. */
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await this.lifecycle.close().catch(() => {});
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Mutex + concurrency slot + lastUsedAt bump + snapshot. `selectorForError` improves not-found messages. */
  async #op(
    action: (page: PWPage) => Promise<{ value?: string | string[] }>,
    selectorForError?: string,
  ): Promise<InteractionResult> {
    if (this.#closing) throw new AgentisError('VALIDATION_FAILED', 'browser session is closed');
    return this.#withMutex(async () => {
      return this.pool.withConcurrencySlot(async () => {
        this.#lastUsedAt = Date.now();
        try {
          const { value } = await action(this.page);
          const snapshot = await this.#snapshot();
          this.#lastUsedAt = Date.now();
          return value === undefined ? { snapshot } : { snapshot, value };
        } catch (err) {
          const snapshot = await this.#snapshot().catch(() => ({ url: '', title: '', text: '' }));
          const message = (err as Error).message ?? String(err);
          // Playwright's timeout on a selector wait/action → a legible NOT_FOUND.
          if (/timeout/i.test(message) && selectorForError !== undefined) {
            throw new AgentisError(
              'VALIDATION_FAILED',
              `browser session: selector "${selectorForError}" not found within timeout`,
              { details: { snapshot } as Record<string, unknown> },
            );
          }
          throw new AgentisError('BROWSER_OPERATION_FAILED', `browser session op failed: ${message}`, {
            details: { snapshot } as Record<string, unknown>,
          });
        }
      });
    });
  }

  async #snapshot(): Promise<PageSnapshot> {
    const [title, text] = await Promise.all([
      this.page.title().catch(() => ''),
      this.page.innerText('body').catch(() => ''),
    ]);
    return { url: this.page.url(), title, text: text.slice(0, SNAPSHOT_TEXT_CHARS) };
  }

  async #withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #sel(selector: unknown): string {
    return this.#requireStr(selector, 'selector');
  }

  #requireStr(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new AgentisError('VALIDATION_FAILED', `browser session op requires a non-empty "${field}"`);
    }
    return value.trim();
  }
}
