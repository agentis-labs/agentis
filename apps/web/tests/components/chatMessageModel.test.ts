import { describe, expect, it } from 'vitest';
import { mergeMessage, sortMessages, type ChatMessageLike } from '../../src/components/chat/messageModel';

function msg(partial: Partial<ChatMessageLike> & Pick<ChatMessageLike, 'id' | 'authorKind' | 'createdAt'>): ChatMessageLike {
  return {
    text: '',
    ...partial,
  };
}

describe('chat message model', () => {
  it('keeps concurrent local turns in chronological order', () => {
    const firstAt = '2026-06-03T10:00:00.000Z';
    const secondAt = '2026-06-03T10:03:00.000Z';

    const ordered = sortMessages([
      msg({ id: 'tmp-turn-b', authorKind: 'operator', text: '?', createdAt: secondAt, metadata: { clientTurnId: 'turn-b' } }),
      msg({ id: 'stream-turn-a', authorKind: 'agent', createdAt: firstAt, metadata: { clientTurnId: 'turn-a' } }),
      msg({ id: 'stream-turn-b', authorKind: 'agent', createdAt: secondAt, metadata: { clientTurnId: 'turn-b' } }),
      msg({ id: 'tmp-turn-a', authorKind: 'operator', text: 'update workflow', createdAt: firstAt, metadata: { clientTurnId: 'turn-a' } }),
    ]);

    expect(ordered.map((message) => message.id)).toEqual([
      'tmp-turn-a',
      'stream-turn-a',
      'tmp-turn-b',
      'stream-turn-b',
    ]);
  });

  it('replaces only the stream with the matching client turn id', () => {
    const current = [
      msg({ id: 'stream-turn-a', authorKind: 'agent', createdAt: '2026-06-03T10:00:00.000Z', metadata: { clientTurnId: 'turn-a' } }),
      msg({ id: 'stream-turn-b', authorKind: 'agent', createdAt: '2026-06-03T10:01:00.000Z', metadata: { clientTurnId: 'turn-b' } }),
    ];
    const persisted = msg({
      id: 'persisted-a',
      authorKind: 'agent',
      text: 'done',
      createdAt: '2026-06-03T10:00:05.000Z',
      metadata: { clientTurnId: 'turn-a' },
    });

    const merged = mergeMessage(current, persisted);

    expect(merged.map((message) => message.id)).toEqual(['persisted-a', 'stream-turn-b']);
    expect(merged[0]?.text).toBe('done');
  });

  it('keeps operator message before streaming agent message even if the operator message has a slightly later database timestamp', () => {
    const streamAt = '2026-06-03T10:00:00.000Z';
    const persistedOperatorAt = '2026-06-03T10:00:00.050Z';

    const ordered = sortMessages([
      msg({ id: 'stream-turn-a', authorKind: 'agent', createdAt: streamAt, metadata: { clientTurnId: 'turn-a' } }),
      msg({ id: 'persisted-operator', authorKind: 'operator', createdAt: persistedOperatorAt, metadata: { clientTurnId: 'turn-a' } }),
    ]);

    expect(ordered.map((message) => message.id)).toEqual([
      'persisted-operator',
      'stream-turn-a',
    ]);
  });

  it('keeps a replaced assistant message in the original local turn position', () => {
    const firstAt = '2026-06-03T10:00:00.000Z';
    const secondAt = '2026-06-03T10:01:00.000Z';
    const current = [
      msg({ id: 'tmp-turn-a', authorKind: 'operator', text: 'first', createdAt: firstAt, metadata: { clientTurnId: 'turn-a' } }),
      msg({ id: 'stream-turn-a', authorKind: 'agent', createdAt: firstAt, metadata: { clientTurnId: 'turn-a' } }),
      msg({ id: 'tmp-turn-b', authorKind: 'operator', text: 'second', createdAt: secondAt, metadata: { clientTurnId: 'turn-b' } }),
      msg({ id: 'stream-turn-b', authorKind: 'agent', createdAt: secondAt, metadata: { clientTurnId: 'turn-b' } }),
    ];
    const persisted = msg({
      id: 'persisted-a',
      authorKind: 'agent',
      text: 'done',
      createdAt: '2026-06-03T10:05:00.000Z',
      metadata: { turn: { clientTurnId: 'turn-a', startedAt: firstAt } },
    });

    const merged = mergeMessage(current, persisted);

    expect(merged.map((message) => message.id)).toEqual([
      'tmp-turn-a',
      'persisted-a',
      'tmp-turn-b',
      'stream-turn-b',
    ]);
  });
});
