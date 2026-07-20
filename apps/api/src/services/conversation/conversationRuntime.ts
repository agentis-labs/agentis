/**
 * ConversationRuntime — the interpreter for a {@link ConversationScript} (GAP
 * B1/B3, the "await-reply" keystone).
 *
 * It advances ONE contact through the script's stages: it performs a stage's
 * `entry` on ENTER, then rests. A resting contact wakes on two events —
 * `onInbound` (the contact replied) and `onWorkflowComplete` (a heavy workflow it
 * launched finished) — and advances. Each contact's position is persisted, so the
 * machine survives restarts and can rest for days between messages.
 *
 * Cost discipline is structural: `send_deterministic` interpolates a template and
 * sends with ZERO model tokens; only `send_agent` and `classify` call the (small)
 * model via `completeJson`. Every side-effecting dependency is injected, so the
 * transition logic is pure and unit-tested in isolation.
 */

import type { ConversationScript, ConversationStage, ConversationContactState } from '@agentis/core';

/** Which App (and workspace) a contact belongs to — the datastore + run scope. */
export interface ConversationContext {
  workspaceId: string;
  appId: string;
  /** User to attribute a `run_workflow` stage's run to (dispatcher inbound / run row). */
  userId?: string;
  ambientId?: string | null;
}

export interface ConversationAttachment {
  url?: string;
  artifactId?: string;
}

export interface ConversationRuntimeDeps {
  /** The App's active script, or null when the App has none (→ not our turn). */
  loadScript(ctx: ConversationContext): ConversationScript | null | Promise<ConversationScript | null>;
  contacts: {
    get(ctx: ConversationContext, script: ConversationScript, address: string): MaybeAsync<ConversationContactState | null>;
    save(ctx: ConversationContext, script: ConversationScript, state: ConversationContactState): MaybeAsync<void>;
    /** Find the contact whose `awaitingRunId` matches — used by the run-complete hook. */
    findByAwaitingRun(ctx: ConversationContext, script: ConversationScript, runId: string): MaybeAsync<ConversationContactState | null>;
  };
  /** Deterministic outbound — no model. */
  send(args: {
    ctx: ConversationContext;
    connectionId: string;
    address: string;
    body: string;
    attachments?: ConversationAttachment[];
    idempotencyKey?: string;
  }): Promise<void>;
  /** One-shot SMALL-model JSON completion (compose / classify). Returns null on failure. */
  completeJson<T extends Record<string, unknown>>(args: {
    ctx: ConversationContext;
    system: string;
    user: string;
  }): Promise<T | null>;
  /**
   * Relevance-based Brain recall for a `send_agent` compose call, scoped to the
   * App. Optional — omitted (or a slow/failed lookup) degrades to today's
   * facts-only prompt, never blocks a send. Without this, scripted conversations
   * only ever see raw recent history, not the workspace's actual memory.
   */
  buildBrainContext?(ctx: ConversationContext, taskDescription: string): Promise<string | null>;
  /** Trigger a heavy workflow; the stage rests until its completion event. */
  startRun(args: {
    ctx: ConversationContext;
    workflowId: string;
    inputs: Record<string, unknown>;
    contactAddress: string;
  }): Promise<{ runId: string }>;
  /** Deposit a graded lesson into the App Brain when a terminal stage declares a deal outcome. */
  recordOutcome?(args: {
    ctx: ConversationContext;
    address: string;
    outcome: 'won' | 'lost' | 'abandoned';
    summary: string;
  }): void | Promise<void>;
  now?(): Date;
  logger?: { warn(msg: string, meta?: unknown): void; info?(msg: string, meta?: unknown): void };
}

type MaybeAsync<T> = T | Promise<T>;

export interface AdvanceResult {
  /** True when the script owns this contact (the dispatcher must NOT run a normal agent turn). */
  handled: boolean;
  stage?: string;
  action?: string;
  sent?: boolean;
  stopped?: boolean;
  reason?: string;
}

const HISTORY_CAP = 30;
export class ConversationRuntime {
  constructor(private readonly deps: ConversationRuntimeDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private stage(script: ConversationScript, id: string): ConversationStage | undefined {
    return script.stages.find((s) => s.id === id);
  }

  /**
   * Enroll a fresh contact and start the script at its initial stage — the
   * outbound-initiated first touch (e.g. the deterministic greeting).
   */
  async enroll(
    ctx: ConversationContext,
    address: string,
    connectionId: string,
    facts?: Record<string, unknown>,
    options?: { startAt?: string | null },
  ): Promise<AdvanceResult> {
    const script = await this.deps.loadScript(ctx);
    if (!script) return { handled: false, reason: 'no_script' };
    const existing = await this.deps.contacts.get(ctx, script, address);
    if (existing && (existing.status === 'active' || existing.status === 'scheduled')) {
      return { handled: true, stage: existing.stage, reason: 'already_enrolled' };
    }
    const state: ConversationContactState = {
      address,
      stage: script.initialStage,
      status: 'active',
      connectionId,
      ...(facts ? { facts } : {}),
      history: existing?.history ?? [],
    };
    // Deferred first touch: persist the intent and stop. The contact rests as a
    // datastore row — no timer, no process — until the sweep finds it due. Only
    // a FUTURE instant defers; a past/now one enrolls immediately, so a caller
    // that computes a stagger offset of zero behaves exactly like today.
    const startAt = options?.startAt;
    if (startAt && new Date(startAt).getTime() > this.now().getTime()) {
      state.status = 'scheduled';
      state.scheduledAt = startAt;
      await this.deps.contacts.save(ctx, script, state);
      return { handled: true, stage: state.stage, reason: 'scheduled' };
    }
    return this.#enterStage(ctx, script, state, script.initialStage);
  }

  /**
   * The scheduled moment arrived — perform the first touch. Called by the sweep;
   * idempotent against a contact that already left `scheduled` (a concurrent
   * sweep, or an early inbound that promoted them).
   */
  async startScheduled(ctx: ConversationContext, address: string): Promise<AdvanceResult> {
    const script = await this.deps.loadScript(ctx);
    if (!script) return { handled: false, reason: 'no_script' };
    const contact = await this.deps.contacts.get(ctx, script, address);
    if (!contact) return { handled: false, reason: 'not_enrolled' };
    if (contact.status !== 'scheduled') return { handled: true, stage: contact.stage, reason: 'not_scheduled' };
    contact.status = 'active';
    contact.scheduledAt = null;
    return this.#enterStage(ctx, script, contact, script.initialStage);
  }

  /** The contact replied while resting — advance per the current stage's `onReply`. */
  async onInbound(ctx: ConversationContext, address: string, text: string): Promise<AdvanceResult> {
    const script = await this.deps.loadScript(ctx);
    if (!script) return { handled: false, reason: 'no_script' };
    const contact = await this.deps.contacts.get(ctx, script, address);
    if (!contact) return { handled: false, reason: 'not_enrolled' };
    // They reached us BEFORE our deferred first touch. Start the script now
    // rather than staying silent and then interrupting a live conversation with
    // a canned greeting later; promoting also consumes the schedule so the
    // sweep cannot fire it a second time.
    if (contact.status === 'scheduled') {
      this.#recordHistory(contact, 'in', text);
      contact.status = 'active';
      contact.scheduledAt = null;
      return this.#enterStage(ctx, script, contact, script.initialStage);
    }
    // A stopped contact is OWNED by the script but silent — it must not fall
    // through to a normal agent turn (the operator asked it to stop sending).
    if (contact.status === 'stopped') return { handled: true, stage: contact.stage, reason: 'stopped' };
    if (contact.status === 'blocked') return { handled: true, stage: contact.stage, reason: contact.blocker?.code ?? 'blocked' };

    this.#recordHistory(contact, 'in', text);
    const stage = this.stage(script, contact.stage);
    if (!stage?.onReply) {
      // Resting with nothing to do on a reply (e.g. mid-workflow). Own it, stay quiet.
      await this.deps.contacts.save(ctx, script, contact);
      return { handled: true, stage: contact.stage, reason: 'resting_no_transition' };
    }

    if (stage.onReply.kind === 'goto') {
      return this.#enterStage(ctx, script, contact, stage.onReply.stage);
    }
    // classify: pick a label with the small model, then branch.
    const label = await this.#classify(ctx, stage.onReply, contact, text);
    const next = label ? stage.onReply.branches[label] : undefined;
    if (!next) {
      await this.deps.contacts.save(ctx, script, contact);
      return { handled: true, stage: contact.stage, action: 'classify', reason: label ? `no_branch_for_${label}` : 'classify_failed' };
    }
    return this.#enterStage(ctx, script, contact, next);
  }

  /** A `run_workflow` stage's run finished — advance per `onComplete`. */
  async onWorkflowComplete(
    ctx: ConversationContext,
    runId: string,
    status: string,
    effective?: { canAdvanceOnSuccess: boolean; reason?: string },
  ): Promise<AdvanceResult> {
    const script = await this.deps.loadScript(ctx);
    if (!script) return { handled: false, reason: 'no_script' };
    const contact = await this.deps.contacts.findByAwaitingRun(ctx, script, runId);
    if (!contact) return { handled: false, reason: 'no_contact_for_run' };
    contact.awaitingRunId = null;
    const stage = this.stage(script, contact.stage);
    // Only advance on success; on failure, clear the wait and rest (operator can intervene).
    // Callers wired to the workflow control plane pass the authoritative
    // outcome. The fallback preserves only legacy clean COMPLETED behavior;
    // contract violations never advance a conversation.
    const successful = effective?.canAdvanceOnSuccess ?? status === 'COMPLETED';
    if (!successful) {
      await this.deps.contacts.save(ctx, script, contact);
      return { handled: true, stage: contact.stage, reason: effective?.reason ?? `run_${status}` };
    }
    if (!stage?.onComplete) {
      await this.deps.contacts.save(ctx, script, contact);
      return { handled: true, stage: contact.stage, reason: 'no_on_complete' };
    }
    return this.#enterStage(ctx, script, contact, stage.onComplete.stage);
  }

  // ── Entering a stage performs its action, then persists the rest position ────

  async #enterStage(
    ctx: ConversationContext,
    script: ConversationScript,
    contact: ConversationContactState,
    stageId: string,
  ): Promise<AdvanceResult> {
    const stage = this.stage(script, stageId);
    if (!stage) {
      this.deps.logger?.warn('conversation.unknown_stage', { appId: ctx.appId, stageId });
      return { handled: true, stage: contact.stage, reason: 'unknown_stage' };
    }
    contact.stage = stageId;
    contact.awaitingRunId = null;
    const entry = stage.entry ?? { kind: 'none' as const };
    let sent = false;
    let action = entry.kind;
    let entryFailure: Error | null = null;

    try {
      if (entry.kind === 'send_deterministic') {
        const body = this.#interpolate(entry.template, contact, localeFor(script, contact));
        await this.#send(ctx, contact, body);
        this.#recordHistory(contact, 'out', body);
        sent = true;
      } else if (entry.kind === 'send_agent') {
        const body = await this.#compose(ctx, entry, contact);
        if (body) {
          const attachments = this.#resolveAttachments(entry.attachFrom, contact);
          await this.#send(ctx, contact, body, attachments);
          this.#recordHistory(contact, 'out', body);
          sent = true;
        } else {
          this.deps.logger?.warn('conversation.compose_failed', { appId: ctx.appId, stageId });
        }
      } else if (entry.kind === 'run_workflow') {
        const inputs = this.#resolveInputs(entry.inputsFrom, contact);
        const { runId } = await this.deps.startRun({ ctx, workflowId: entry.workflowId, inputs, contactAddress: contact.address });
        contact.awaitingRunId = runId;
        action = 'run_workflow';
      }
    } catch (err) {
      entryFailure = err instanceof Error ? err : new Error(String(err));
      this.deps.logger?.warn('conversation.entry_failed', { appId: ctx.appId, stageId, err: (err as Error).message });
    }

    if (entryFailure) {
      contact.status = 'blocked';
      contact.blocker = {
        code: /acknowledg|pending|queued/i.test(entryFailure.message) ? 'CHANNEL_DELIVERY_PENDING' : 'STAGE_ENTRY_FAILED',
        message: entryFailure.message,
        at: this.now().toISOString(),
      };
      contact.updatedAt = this.now().toISOString();
      await this.deps.contacts.save(ctx, script, contact);
      return { handled: true, stage: stageId, action, sent: false, stopped: false, reason: contact.blocker.code };
    }

    // Terminal stage = stop. Otherwise rest (awaiting reply or workflow).
    delete contact.blocker;
    contact.status = stage.terminal ? 'stopped' : 'active';
    contact.updatedAt = this.now().toISOString();
    await this.deps.contacts.save(ctx, script, contact);
    // A terminal stage that declares an outcome feeds the App Brain (won/lost),
    // so the App's agent learns from each closed conversation over time.
    if (stage.terminal && stage.outcome && this.deps.recordOutcome) {
      const summary = (contact.history ?? []).slice(-4).map((h) => `${h.role === 'in' ? 'them' : 'us'}: ${h.text}`).join(' | ');
      try {
        await this.deps.recordOutcome({ ctx, address: contact.address, outcome: stage.outcome, summary });
      } catch (err) {
        this.deps.logger?.warn('conversation.record_outcome_failed', { appId: ctx.appId, err: (err as Error).message });
      }
    }
    return { handled: true, stage: stageId, action, sent, stopped: stage.terminal === true };
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  async #send(ctx: ConversationContext, contact: ConversationContactState, body: string, attachments?: ConversationAttachment[]): Promise<void> {
    if (!contact.connectionId) {
      throw new Error(`conversation contact ${contact.address} has no channel connection`);
    }
    await this.deps.send({
      ctx,
      connectionId: contact.connectionId,
      address: contact.address,
      body,
      idempotencyKey: `conversation:${ctx.appId}:${contact.address}:${contact.stage}`,
      ...(attachments && attachments.length ? { attachments } : {}),
    });
  }

  async #compose(ctx: ConversationContext, entry: { brief: string }, contact: ConversationContactState): Promise<string | null> {
    const system =
      'You compose ONE short, human message for a chat conversation. Write in the SAME language the contact is using '
      + '(match the language of their recent messages; if there are none, follow the instruction\'s language). '
      + 'No greeting boilerplate unless asked, no markdown, no emoji spam, no signature. Return JSON: { "message": string }.';
    // Relevance-based Brain recall (not just raw recent history) — the same
    // "buffet, not soup" retrieval the main chat surface already gets. Best
    // effort: a missing dep or a failed/slow lookup just omits the block.
    const brainBlock = this.deps.buildBrainContext
      ? await this.deps.buildBrainContext(ctx, entry.brief).catch(() => null)
      : null;
    const user =
      `Instruction: ${entry.brief}\n\n`
      + `Contact facts: ${JSON.stringify(contact.facts ?? {})}\n`
      + (brainBlock ? `Brain memory:\n${brainBlock}\n\n` : '')
      + `Recent conversation: ${JSON.stringify((contact.history ?? []).slice(-8))}`;
    const out = await this.deps.completeJson<{ message?: unknown }>({ ctx, system, user });
    const message = typeof out?.message === 'string' ? out.message.trim() : '';
    return message || null;
  }

  async #classify(
    ctx: ConversationContext,
    onReply: { brief: string; labels: string[] },
    contact: ConversationContactState,
    reply: string,
  ): Promise<string | null> {
    const system =
      `You classify a contact's reply into EXACTLY one of these labels: ${onReply.labels.join(', ')}. `
      + 'Return JSON: { "label": string } where label is one of the allowed labels.';
    const user = `Task: ${onReply.brief}\n\nContact reply: ${JSON.stringify(reply)}\nContact facts: ${JSON.stringify(contact.facts ?? {})}`;
    const out = await this.deps.completeJson<{ label?: unknown }>({ ctx, system, user });
    const label = typeof out?.label === 'string' ? out.label.trim() : '';
    return onReply.labels.includes(label) ? label : null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Interpolate `{greeting}`, `{contact.<f>}`, `{facts.<f>}` — pure, zero tokens. */
  #interpolate(template: string, contact: ConversationContactState, locale: string): string {
    return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_m, key: string) => {
      if (key === 'greeting') return timeGreeting(this.now(), locale);
      if (key.startsWith('facts.')) return String(readPath(contact.facts, key.slice('facts.'.length)) ?? '');
      if (key.startsWith('contact.')) return String(readPath(contact as unknown as Record<string, unknown>, key.slice('contact.'.length)) ?? '');
      return String(readPath(contact.facts, key) ?? '');
    }).replace(/\s{2,}/g, ' ').trim();
  }

  #resolveAttachments(fields: string[], contact: ConversationContactState): ConversationAttachment[] {
    const out: ConversationAttachment[] = [];
    for (const field of fields) {
      const value = readPath(contact.facts, field) ?? readPath(contact as unknown as Record<string, unknown>, field);
      if (typeof value === 'string' && value.trim()) out.push({ url: value.trim() });
    }
    return out;
  }

  #resolveInputs(inputsFrom: Record<string, string>, contact: ConversationContactState): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(inputsFrom)) {
      inputs[key] = readPath(contact.facts, field) ?? readPath(contact as unknown as Record<string, unknown>, field) ?? null;
    }
    return inputs;
  }

  #recordHistory(contact: ConversationContactState, role: 'in' | 'out', text: string): void {
    const history = contact.history ?? (contact.history = []);
    history.push({ at: this.now().toISOString(), role, text });
    if (history.length > HISTORY_CAP) contact.history = history.slice(-HISTORY_CAP);
  }
}

/**
 * Localized time-of-day greeting [morning, afternoon, evening]. English is the
 * default; a handful of common languages ship as a convenience, and any App can
 * set its own `locale` (or just write its own template without `{greeting}`).
 * Agentis assumes NO language — this is a helper, not a policy.
 */
const GREETINGS: Record<string, readonly [string, string, string]> = {
  en: ['good morning', 'good afternoon', 'good evening'],
  pt: ['bom dia', 'boa tarde', 'boa noite'],
  es: ['buenos días', 'buenas tardes', 'buenas noches'],
  fr: ['bonjour', 'bon après-midi', 'bonsoir'],
  de: ['guten Morgen', 'guten Tag', 'guten Abend'],
  it: ['buongiorno', 'buon pomeriggio', 'buonasera'],
  nl: ['goedemorgen', 'goedemiddag', 'goedenavond'],
};

export function timeGreeting(date: Date, locale = 'en'): string {
  const table = GREETINGS[locale.slice(0, 2).toLowerCase()] ?? GREETINGS.en!;
  const h = date.getHours();
  return h < 12 ? table[0] : h < 18 ? table[1] : table[2];
}

/** Resolve the language for `{greeting}`: contact override › script default › English. */
function localeFor(script: ConversationScript, contact: ConversationContactState): string {
  const fromFacts = contact.facts && typeof contact.facts.locale === 'string' ? contact.facts.locale : undefined;
  return fromFacts ?? script.locale ?? 'en';
}

function readPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
