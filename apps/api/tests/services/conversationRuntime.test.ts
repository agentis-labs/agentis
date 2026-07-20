/**
 * ConversationRuntime — the await-reply state machine (GAP B1/B3). All side
 * effects are injected, so these tests drive the pure transition logic and assert
 * the cost discipline (deterministic stages spend ZERO model calls).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { ConversationScript, ConversationContactState } from '@agentis/core';
import { conversationScriptSchema } from '@agentis/core';
import {
  ConversationRuntime,
  timeGreeting,
  type ConversationRuntimeDeps,
  type ConversationContext,
} from '../../src/services/conversation/conversationRuntime.js';

// The exact sales-desk shape from the gap analysis: greet → pitch → qualify →
// build (workflow) → deliver(stop), with a negative branch to closed(stop).
const SCRIPT: ConversationScript = conversationScriptSchema.parse({
  contactCollection: 'contacts',
  locale: 'pt', // this test App speaks Brazilian Portuguese; the platform assumes none
  initialStage: 'greet',
  stages: [
    { id: 'greet', entry: { kind: 'send_deterministic', template: 'Oi, {greeting}' }, onReply: { kind: 'goto', stage: 'pitch' } },
    {
      id: 'pitch',
      entry: { kind: 'send_agent', brief: 'personalized pitch from their instagram' },
      onReply: { kind: 'classify', brief: 'is the store interested?', labels: ['positive', 'negative'], branches: { positive: 'build', negative: 'closed' } },
    },
    { id: 'build', entry: { kind: 'run_workflow', workflowId: 'wf-fsf', inputsFrom: { store: 'brand' } }, onComplete: { stage: 'deliver' } },
    { id: 'deliver', entry: { kind: 'send_agent', brief: 'deliver the store urls', attachFrom: ['mockup'] }, terminal: true, outcome: 'won' },
    { id: 'closed', terminal: true, outcome: 'lost' },
  ],
});

const CTX: ConversationContext = { workspaceId: 'ws1', appId: 'app1' };

function harness(script: ConversationScript = SCRIPT) {
  const contacts = new Map<string, ConversationContactState>();
  const sends: Array<{ address: string; body: string; attachments?: Array<{ url?: string; artifactId?: string }> }> = [];
  const runs: Array<{ workflowId: string; inputs: Record<string, unknown>; contactAddress: string }> = [];
  const stats = { completeCalls: 0 };
  const outcomes: Array<{ address: string; outcome: string; summary: string }> = [];
  const control = { classifyLabel: 'positive', composed: 'mensagem composta' as string | null };

  const deps: ConversationRuntimeDeps = {
    loadScript: () => script,
    contacts: {
      get: (_c, _s, address) => contacts.get(address) ?? null,
      save: (_c, _s, state) => { contacts.set(state.address, JSON.parse(JSON.stringify(state))); },
      findByAwaitingRun: (_c, _s, runId) => [...contacts.values()].find((c) => c.awaitingRunId === runId) ?? null,
    },
    send: async ({ address, body, attachments }) => { sends.push({ address, body, ...(attachments ? { attachments } : {}) }); },
    completeJson: async ({ system }) => {
      stats.completeCalls += 1;
      if (/classif/i.test(system)) return { label: control.classifyLabel } as never;
      return (control.composed === null ? {} : { message: control.composed }) as never;
    },
    startRun: async ({ workflowId, inputs, contactAddress }) => { runs.push({ workflowId, inputs, contactAddress }); return { runId: `run-${runs.length}` }; },
    recordOutcome: ({ address, outcome, summary }) => { outcomes.push({ address, outcome, summary }); },
    // 09:00 LOCAL → "bom dia", deterministically (no trailing Z = local parse).
    now: () => new Date('2026-07-06T09:00:00'),
  };
  return { deps, runtime: new ConversationRuntime(deps), contacts, sends, runs, stats, control, outcomes };
}

describe('timeGreeting (localized, zero tokens — no language assumed)', () => {
  it('defaults to English and localizes by the given code', () => {
    expect(timeGreeting(new Date('2026-07-06T09:00:00'))).toBe('good morning'); // default en
    expect(timeGreeting(new Date('2026-07-06T15:00:00'), 'pt')).toBe('boa tarde');
    expect(timeGreeting(new Date('2026-07-06T21:00:00'), 'es')).toBe('buenas noches');
    expect(timeGreeting(new Date('2026-07-06T09:00:00'), 'xx')).toBe('good morning'); // unknown → en
  });
});

describe('ConversationRuntime — deferred first touch', () => {
  // The harness clock is fixed at 09:00 local; derive both instants from it so
  // these assertions hold in any timezone.
  const NOW = new Date('2026-07-06T09:00:00').getTime();
  const LATER = new Date(NOW + 60 * 60_000).toISOString();
  const EARLIER = new Date(NOW - 60 * 60_000).toISOString();

  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('parks a contact as scheduled without sending anything', async () => {
    const r = await h.runtime.enroll(CTX, '+5511999', 'conn1', undefined, { startAt: LATER });

    expect(r).toMatchObject({ handled: true, stage: 'greet', reason: 'scheduled' });
    expect(h.sends).toEqual([]);
    expect(h.stats.completeCalls).toBe(0);
    expect(h.contacts.get('+5511999')).toMatchObject({
      stage: 'greet',
      status: 'scheduled',
      scheduledAt: LATER,
      connectionId: 'conn1',
    });
  });

  it('sends the first touch when the scheduled moment is swept', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1', undefined, { startAt: LATER });
    const r = await h.runtime.startScheduled(CTX, '+5511999');

    expect(r).toMatchObject({ handled: true, stage: 'greet', sent: true });
    expect(h.sends).toEqual([{ address: '+5511999', body: 'Oi, bom dia' }]);
    expect(h.contacts.get('+5511999')).toMatchObject({ status: 'active', scheduledAt: null });
  });

  it('is idempotent — a second sweep of the same contact never re-sends', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1', undefined, { startAt: LATER });
    await h.runtime.startScheduled(CTX, '+5511999');
    const again = await h.runtime.startScheduled(CTX, '+5511999');

    expect(again).toMatchObject({ handled: true, reason: 'not_scheduled' });
    expect(h.sends).toHaveLength(1);
  });

  it('starts immediately when the instant has already passed', async () => {
    const r = await h.runtime.enroll(CTX, '+5511999', 'conn1', undefined, { startAt: EARLIER });

    expect(r).toMatchObject({ handled: true, stage: 'greet', sent: true });
    expect(h.contacts.get('+5511999')?.status).toBe('active');
  });

  it('promotes a scheduled contact who reaches out first, consuming the schedule', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1', undefined, { startAt: LATER });
    const r = await h.runtime.onInbound(CTX, '+5511999', 'oi, vi seu perfil');

    expect(r).toMatchObject({ handled: true, stage: 'greet', sent: true });
    const contact = h.contacts.get('+5511999');
    expect(contact).toMatchObject({ status: 'active', scheduledAt: null });
    // Their message is retained, and the now-consumed schedule cannot fire again.
    expect(contact?.history?.some((entry) => entry.role === 'in')).toBe(true);
    expect(await h.runtime.startScheduled(CTX, '+5511999')).toMatchObject({ reason: 'not_scheduled' });
    expect(h.sends).toHaveLength(1);
  });

  it('does not re-enroll a contact already waiting on a scheduled touch', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1', undefined, { startAt: LATER });
    const second = await h.runtime.enroll(CTX, '+5511999', 'conn1', undefined, { startAt: LATER });

    expect(second).toMatchObject({ handled: true, reason: 'already_enrolled' });
    expect(h.sends).toEqual([]);
  });
});

describe('ConversationRuntime', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('enroll sends the deterministic greeting with ZERO model calls', async () => {
    const r = await h.runtime.enroll(CTX, '+5511999', 'conn1');
    expect(r).toMatchObject({ handled: true, stage: 'greet', sent: true });
    expect(h.sends).toEqual([{ address: '+5511999', body: 'Oi, bom dia' }]);
    expect(h.stats.completeCalls).toBe(0); // the whole point: no tokens for msg1
    expect(h.contacts.get('+5511999')).toMatchObject({ stage: 'greet', status: 'active', connectionId: 'conn1' });
  });

  it('blocks the contact instead of awaiting a reply when outbound proof is missing', async () => {
    h.deps.send = async () => { throw new Error('channel delivery is pending provider acknowledgement'); };
    const r = await h.runtime.enroll(CTX, '+5511999', 'conn1');

    expect(r).toMatchObject({ handled: true, stage: 'greet', sent: false, reason: 'CHANNEL_DELIVERY_PENDING' });
    expect(h.contacts.get('+5511999')).toMatchObject({
      stage: 'greet',
      status: 'blocked',
      blocker: { code: 'CHANNEL_DELIVERY_PENDING' },
    });
    await expect(h.runtime.onInbound(CTX, '+5511999', 'oi?')).resolves.toMatchObject({ handled: true, reason: 'CHANNEL_DELIVERY_PENDING' });
  });

  it('a reply to the greeting advances to the agent-composed pitch (one model call)', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1');
    const r = await h.runtime.onInbound(CTX, '+5511999', 'oi!');
    expect(r).toMatchObject({ handled: true, stage: 'pitch', sent: true });
    expect(h.sends[1]).toMatchObject({ body: 'mensagem composta' });
    expect(h.stats.completeCalls).toBe(1); // compose only
    expect(h.contacts.get('+5511999')?.stage).toBe('pitch');
  });

  it('a POSITIVE reply to the pitch classifies then triggers the build workflow (no send, rests on the run)', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1');
    await h.runtime.onInbound(CTX, '+5511999', 'oi!');           // → pitch (compose)
    h.control.classifyLabel = 'positive';
    const before = h.sends.length;
    const r = await h.runtime.onInbound(CTX, '+5511999', 'adorei, quero!'); // classify → build
    expect(r).toMatchObject({ handled: true, stage: 'build', action: 'run_workflow' });
    expect(h.runs).toEqual([{ workflowId: 'wf-fsf', inputs: { store: null }, contactAddress: '+5511999' }]);
    expect(h.sends.length).toBe(before); // run_workflow sends nothing
    const c = h.contacts.get('+5511999');
    expect(c?.stage).toBe('build');
    expect(c?.awaitingRunId).toBe('run-1');
  });

  it('the build completing wakes the contact and delivers the terminal message with its attachment, then STOPS', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1');
    await h.runtime.onInbound(CTX, '+5511999', 'oi!');
    await h.runtime.onInbound(CTX, '+5511999', 'quero!');        // → build (awaitingRunId run-1)
    // Seed a fact the deliver stage attaches.
    const c = h.contacts.get('+5511999')!;
    c.facts = { mockup: 'artifact:img-123' };
    h.deps.contacts.save(CTX, SCRIPT, c);
    h.control.composed = 'aqui está sua loja: https://x.vercel.app';

    const r = await h.runtime.onWorkflowComplete(CTX, 'run-1', 'COMPLETED');
    expect(r).toMatchObject({ handled: true, stage: 'deliver', sent: true, stopped: true });
    const last = h.sends.at(-1)!;
    expect(last.body).toContain('vercel.app');
    expect(last.attachments).toEqual([{ url: 'artifact:img-123' }]);
    expect(h.contacts.get('+5511999')?.status).toBe('stopped');
  });

  it('a terminal stage with an outcome feeds the App Brain (won on deliver, lost on closed)', async () => {
    // WON: build completes → deliver (terminal, outcome:'won').
    await h.runtime.enroll(CTX, '+5511999', 'conn1');
    await h.runtime.onInbound(CTX, '+5511999', 'oi!');
    await h.runtime.onInbound(CTX, '+5511999', 'quero!');
    await h.runtime.onWorkflowComplete(CTX, 'run-1', 'COMPLETED');
    expect(h.outcomes.at(-1)).toMatchObject({ address: '+5511999', outcome: 'won' });
    expect(h.outcomes.at(-1)!.summary).toMatch(/them:|us:/); // the recent exchange is summarized

    // LOST: a negative reply → closed (terminal, outcome:'lost').
    await h.runtime.enroll(CTX, '+5511000', 'conn1');
    await h.runtime.onInbound(CTX, '+5511000', 'oi!');
    h.control.classifyLabel = 'negative';
    await h.runtime.onInbound(CTX, '+5511000', 'não');
    expect(h.outcomes.at(-1)).toMatchObject({ address: '+5511000', outcome: 'lost' });
  });

  it('a stopped contact is owned but SILENT — no further sends, and it never falls through to an agent turn', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1');
    await h.runtime.onInbound(CTX, '+5511999', 'oi!');
    await h.runtime.onInbound(CTX, '+5511999', 'quero!');
    await h.runtime.onWorkflowComplete(CTX, 'run-1', 'COMPLETED'); // → deliver (stopped)
    const before = h.sends.length;
    const r = await h.runtime.onInbound(CTX, '+5511999', 'obrigado!');
    expect(r).toMatchObject({ handled: true, reason: 'stopped' });
    expect(h.sends.length).toBe(before); // silent
  });

  it('a NEGATIVE reply routes to the terminal closed stage (no build)', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1');
    await h.runtime.onInbound(CTX, '+5511999', 'oi!');
    h.control.classifyLabel = 'negative';
    const r = await h.runtime.onInbound(CTX, '+5511999', 'não tenho interesse');
    expect(r).toMatchObject({ handled: true, stage: 'closed', stopped: true });
    expect(h.runs).toEqual([]); // never built
    expect(h.contacts.get('+5511999')?.status).toBe('stopped');
  });

  it('an unknown classify label rests in place (no drift on an ambiguous reply)', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1');
    await h.runtime.onInbound(CTX, '+5511999', 'oi!');
    h.control.classifyLabel = 'maybe'; // not in labels
    const r = await h.runtime.onInbound(CTX, '+5511999', 'talvez');
    expect(r.handled).toBe(true);
    expect(h.contacts.get('+5511999')?.stage).toBe('pitch'); // stayed
  });

  it('an inbound from a non-enrolled contact is NOT handled (a normal agent turn proceeds)', async () => {
    const r = await h.runtime.onInbound(CTX, '+55stranger', 'oi');
    expect(r).toEqual({ handled: false, reason: 'not_enrolled' });
  });

  it('a failed build clears the wait and rests (no advance)', async () => {
    await h.runtime.enroll(CTX, '+5511999', 'conn1');
    await h.runtime.onInbound(CTX, '+5511999', 'oi!');
    await h.runtime.onInbound(CTX, '+5511999', 'quero!');
    const r = await h.runtime.onWorkflowComplete(CTX, 'run-1', 'FAILED');
    expect(r).toMatchObject({ handled: true, stage: 'build', reason: 'run_FAILED' });
    expect(h.contacts.get('+5511999')?.awaitingRunId).toBeNull();
  });
});

describe('ConversationRuntime — Brain memory recall in #compose', () => {
  function harnessCapturingPrompts(overrides: Partial<ConversationRuntimeDeps> = {}) {
    const capturedUsers: string[] = [];
    const base = harness();
    const deps: ConversationRuntimeDeps = {
      ...base.deps,
      completeJson: async ({ system, user }) => {
        capturedUsers.push(user);
        if (/classif/i.test(system)) return { label: 'positive' } as never;
        return { message: 'composed' } as never;
      },
      ...overrides,
    };
    return { runtime: new ConversationRuntime(deps), capturedUsers };
  }

  it('includes the Brain memory block in the composed prompt when buildBrainContext is provided', async () => {
    const { runtime, capturedUsers } = harnessCapturingPrompts({
      buildBrainContext: async () => 'Remember: this contact prefers WhatsApp over email.',
    });
    await runtime.enroll(CTX, '+5511999', 'conn1');
    await runtime.onInbound(CTX, '+5511999', 'oi!'); // → pitch (a send_agent compose call)
    expect(capturedUsers.some((u) => u.includes('Brain memory:') && u.includes('prefers WhatsApp over email'))).toBe(true);
  });

  it('omits the Brain memory block entirely when buildBrainContext is not wired', async () => {
    const { runtime, capturedUsers } = harnessCapturingPrompts();
    await runtime.enroll(CTX, '+5511999', 'conn1');
    await runtime.onInbound(CTX, '+5511999', 'oi!');
    expect(capturedUsers.length).toBeGreaterThan(0);
    expect(capturedUsers.every((u) => !u.includes('Brain memory:'))).toBe(true);
  });

  it('a failing buildBrainContext degrades to no memory block instead of throwing', async () => {
    const { runtime, capturedUsers } = harnessCapturingPrompts({
      buildBrainContext: async () => { throw new Error('brain lookup boom'); },
    });
    await expect(runtime.enroll(CTX, '+5511999', 'conn1')).resolves.toBeDefined();
    await expect(runtime.onInbound(CTX, '+5511999', 'oi!')).resolves.toBeDefined();
    expect(capturedUsers.every((u) => !u.includes('Brain memory:'))).toBe(true);
  });
});
