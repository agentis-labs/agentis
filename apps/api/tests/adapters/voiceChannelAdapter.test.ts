/**
 * VoiceChannelAdapter — Living Apps G6 (foundation, webhook-transcription voice).
 *
 * Unit coverage: verify() fail-closed secret check, parseInbound() of the
 * { callId, from, transcript } webhook shape, and send() → takeReply() buffering
 * with the pluggable (default no-op) TTS hook.
 *
 * Round-trip coverage: a voice webhook payload flows through the REAL
 * ChannelBridge → ChannelTurnDispatcher spine exactly like a text channel — a
 * turn runs, the reply is persisted as an agent message, AND delivered to the
 * adapter where the provider can retrieve it (with an optional ttsUrl).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { AgentAdapter, ChatDelta } from '@agentis/core';
import { VoiceChannelAdapter } from '../../src/adapters/channels/voice.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { ChannelBridge } from '../../src/services/channelBridge.js';
import { ChannelTurnDispatcher } from '../../src/services/channelTurnDispatcher.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';

/** A chat-capable adapter stub — only `.chat`/`.capabilities` are exercised. */
function chatStub(reply: string): AgentAdapter {
  return {
    capabilities: () => ({ interactiveChat: true }),
    async *chat(): AsyncIterable<ChatDelta> {
      yield { type: 'text', delta: reply };
      yield { type: 'done', finishReason: 'stop' };
    },
  } as unknown as AgentAdapter;
}

describe('VoiceChannelAdapter', () => {
  describe('verify()', () => {
    it('fails closed when no secret is configured', () => {
      const a = new VoiceChannelAdapter();
      expect(a.verify({ headers: {}, rawBody: '', secret: null })).toBe(false);
      expect(a.verify({ headers: { 'x-agentis-voice-secret': 'anything' }, rawBody: '', secret: null })).toBe(false);
    });

    it('returns true only when the x-agentis-voice-secret header matches', () => {
      const a = new VoiceChannelAdapter();
      expect(a.verify({ headers: { 'x-agentis-voice-secret': 'shh' }, rawBody: '', secret: 'shh' })).toBe(true);
      expect(a.verify({ headers: { 'x-agentis-voice-secret': 'wrong' }, rawBody: '', secret: 'shh' })).toBe(false);
      expect(a.verify({ headers: {}, rawBody: '', secret: 'shh' })).toBe(false);
    });
  });

  describe('parseInbound()', () => {
    it('maps { callId, from, transcript } → body/chatId/from', () => {
      const a = new VoiceChannelAdapter();
      const result = a.parseInbound({
        rawBody: JSON.stringify({ callId: 'call_123', from: '+15551234567', transcript: 'what are your hours?' }),
        headers: {},
      });
      expect(result).toMatchObject({
        chatId: 'call_123',
        body: 'what are your hours?',
        from: '+15551234567',
      });
      // externalId derives a stable per-utterance idempotency key from the call.
      expect(result?.externalId).toMatch(/^voice:call_123:/);
    });

    it('prefers a provider-supplied utteranceId for the idempotency key', () => {
      const a = new VoiceChannelAdapter();
      const result = a.parseInbound({
        rawBody: JSON.stringify({ callId: 'c1', transcript: 'hi', utteranceId: 'utt-9' }),
        headers: {},
      });
      expect(result?.externalId).toBe('voice:utt-9');
    });

    it('returns null for a silent/partial transcription (nothing to act on)', () => {
      const a = new VoiceChannelAdapter();
      expect(a.parseInbound({ rawBody: JSON.stringify({ callId: 'c1', transcript: '   ' }), headers: {} })).toBeNull();
    });

    it('throws VALIDATION_FAILED on a missing callId or non-JSON body', () => {
      const a = new VoiceChannelAdapter();
      expect(() => a.parseInbound({ rawBody: JSON.stringify({ transcript: 'hi' }), headers: {} })).toThrow(/callId/);
      expect(() => a.parseInbound({ rawBody: 'not json', headers: {} })).toThrow(/VALIDATION_FAILED|JSON/i);
    });
  });

  describe('send() → takeReply()', () => {
    it('buffers the reply per call with a null ttsUrl when no TTS hook is wired', async () => {
      const a = new VoiceChannelAdapter();
      await a.send({ token: '', chatId: 'call_1', body: 'We are open 9 to 5.' });
      const reply = a.takeReply('call_1');
      expect(reply).toMatchObject({ text: 'We are open 9 to 5.', ttsUrl: null });
      // takeReply consumes — a second read is empty.
      expect(a.takeReply('call_1')).toBeNull();
    });

    it('uses the pluggable TTS hook to attach a ttsUrl', async () => {
      const a = new VoiceChannelAdapter({
        synthesize: ({ text, callId }) => `https://tts.example/${callId}?say=${encodeURIComponent(text)}`,
      });
      await a.send({ token: '', chatId: 'call_2', body: 'Hello' });
      expect(a.peekReply('call_2')?.ttsUrl).toBe('https://tts.example/call_2?say=Hello');
    });

    it('still buffers the text reply when the TTS hook throws (best-effort synthesis)', async () => {
      const a = new VoiceChannelAdapter({ synthesize: () => { throw new Error('tts down'); } });
      await a.send({ token: '', chatId: 'call_3', body: 'fallback text' });
      expect(a.takeReply('call_3')).toMatchObject({ text: 'fallback text', ttsUrl: null });
    });
  });

  describe('round-trip through the dispatcher', () => {
    let ctx: TestContext;
    beforeEach(async () => { ctx = await createTestContext(); });
    afterEach(() => ctx.close());

    function seedAgent(): string {
      const id = randomUUID();
      ctx.db.insert(schema.agents).values({
        id,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        name: 'Orchestrator',
        adapterType: 'http',
      }).run();
      return id;
    }

    it('webhook transcript → ParsedInboundMessage → turn → reply captured & deliverable with a ttsUrl', async () => {
      const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
      const voice = new VoiceChannelAdapter({
        synthesize: ({ text }) => `https://tts.example/say?text=${encodeURIComponent(text)}`,
      });
      const bridge = new ChannelBridge({
        db: ctx.db, vault: ctx.vault, conversations, bus: ctx.bus, logger: ctx.logger,
        adapters: { voice },
      });
      const agentId = seedAgent();
      // A voice connection needs no token — its webhookSecret is the credential.
      const { connection, webhookSecret } = bridge.create({
        workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
        agentId, kind: 'voice', name: 'sales line',
      });

      const dispatcher = new ChannelTurnDispatcher({
        db: ctx.db,
        adapters: new AdapterManager(ctx.logger),
        conversations,
        logger: ctx.logger,
        deliver: (args) => bridge.deliverToConnection(args),
        fallbackAdapter: () => chatStub('We are open 9 to 5, Monday to Friday.'),
      });
      bridge.setTurnDispatcher(dispatcher);

      const rawBody = JSON.stringify({ callId: 'call_777', from: '+15550001111', transcript: 'what are your hours?' });
      const result = await bridge.handleInbound({
        connectionId: connection.id,
        headers: { 'x-agentis-voice-secret': webhookSecret },
        rawBody,
      });
      expect(result.accepted).toBe(true);

      // Dispatcher runs fire-and-forget; drain microtasks.
      await new Promise((r) => setTimeout(r, 30));

      // The inbound transcript is mirrored, and the agent's reply is persisted.
      const conv = conversations.list(ctx.workspace.id)[0]!;
      const messages = conversations.messages(conv.id, 50);
      expect(messages.some((m) => m.authorType === 'system' && m.body.includes('what are your hours?'))).toBe(true);
      expect(messages.some((m) => m.authorType === 'agent' && m.body.includes('open 9 to 5'))).toBe(true);

      // The reply was delivered to the voice adapter → buffered for the provider,
      // carrying a synthesized ttsUrl alongside the spoken text.
      const reply = voice.takeReply('call_777');
      expect(reply?.text).toContain('open 9 to 5');
      expect(reply?.ttsUrl).toBe('https://tts.example/say?text=' + encodeURIComponent('We are open 9 to 5, Monday to Friday.'));
    });

    it('rejects an inbound webhook with a wrong secret (fail-closed)', async () => {
      const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
      const voice = new VoiceChannelAdapter();
      const bridge = new ChannelBridge({
        db: ctx.db, vault: ctx.vault, conversations, bus: ctx.bus, logger: ctx.logger,
        adapters: { voice },
      });
      const agentId = seedAgent();
      const { connection } = bridge.create({
        workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
        agentId, kind: 'voice', name: 'line',
      });
      await expect(bridge.handleInbound({
        connectionId: connection.id,
        headers: { 'x-agentis-voice-secret': 'wrong' },
        rawBody: JSON.stringify({ callId: 'c', transcript: 'hi' }),
      })).rejects.toMatchObject({ code: 'CHANNEL_SIGNATURE_INVALID' });
    });
  });
});
