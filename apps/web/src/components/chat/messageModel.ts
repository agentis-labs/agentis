import type { ToolCallData } from './toolCalls';

export interface ChatMessageLike {
  id: string;
  authorKind: 'operator' | 'agent' | 'system';
  text: string;
  createdAt: string;
  metadata?: {
    clientTurnId?: string;
    toolCalls?: ToolCallData[];
    thinking?: string;
    [key: string]: unknown;
  };
}

function timestamp(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function localKindRank(message: ChatMessageLike): number {
  if (message.authorKind === 'operator') return 0;
  if (message.authorKind === 'agent') return 1;
  return 2;
}

function localIdRank(id: string): number {
  if (id.startsWith('tmp-')) return 0;
  if (id.startsWith('stream-')) return 1;
  return 2;
}

export function sortMessages<T extends ChatMessageLike>(messages: T[]): T[] {
  return [...messages].sort((a, b) => {
    const turnA = a.metadata?.clientTurnId ?? turnIdFromLocalId(a.id);
    const turnB = b.metadata?.clientTurnId ?? turnIdFromLocalId(b.id);
    if (turnA && turnA === turnB) {
      const kindDiff = localKindRank(a) - localKindRank(b);
      if (kindDiff !== 0) return kindDiff;
    }

    const timeDiff = timestamp(a.createdAt) - timestamp(b.createdAt);
    if (timeDiff !== 0) return timeDiff;

    const localDiff = localIdRank(a.id) - localIdRank(b.id);
    if (localDiff !== 0) return localDiff;
    return a.id.localeCompare(b.id);
  });
}

export function dedupeMessages<T extends ChatMessageLike>(messages: T[]): T[] {
  const byId = new Map<string, T>();
  for (const message of sortMessages(messages)) byId.set(message.id, message);
  return Array.from(byId.values());
}

export function upsertMessage<T extends ChatMessageLike>(messages: T[], next: T): T[] {
  let found = false;
  const updated = messages.map((message) => {
    if (message.id !== next.id) return message;
    found = true;
    return next;
  });
  return dedupeMessages(found ? updated : [...updated, next]);
}

export function prependUnique<T extends ChatMessageLike>(messages: T[], older: T[]): T[] {
  const seen = new Set(messages.map((message) => message.id));
  return sortMessages([...older.filter((message) => !seen.has(message.id)), ...messages]);
}

export function mergeMessage<T extends ChatMessageLike>(messages: T[], incoming: T): T[] {
  if (messages.some((message) => message.id === incoming.id)) {
    return upsertMessage(messages, incoming);
  }

  const incomingTurnId = incoming.metadata?.clientTurnId;
  if (incoming.authorKind === 'operator') {
    const optimisticIndex = messages.findIndex((message) => {
      if (!message.id.startsWith('tmp-') || message.authorKind !== 'operator') return false;
      const turnId = message.metadata?.clientTurnId ?? turnIdFromLocalId(message.id);
      if (incomingTurnId && turnId) return incomingTurnId === turnId;
      return message.text === incoming.text;
    });
    if (optimisticIndex >= 0) {
      return dedupeMessages(messages.map((message, index) => (index === optimisticIndex ? incoming : message)));
    }
  }

  if (incoming.authorKind === 'agent') {
    const streamingIndex = messages.findIndex((message) => {
      if (!message.id.startsWith('stream-') || message.authorKind !== 'agent') return false;
      const turnId = message.metadata?.clientTurnId ?? turnIdFromLocalId(message.id);
      if (incomingTurnId || turnId) return incomingTurnId === turnId;
      const currentText = message.text.trim();
      return currentText.length === 0 || currentText === incoming.text;
    });
    if (streamingIndex >= 0) {
      return dedupeMessages(messages.map((message, index) => (index === streamingIndex ? incoming : message)));
    }
  }

  return dedupeMessages([...messages, incoming]);
}

function turnIdFromLocalId(id: string): string | null {
  if (id.startsWith('tmp-')) return id.slice('tmp-'.length);
  if (id.startsWith('stream-')) return id.slice('stream-'.length);
  return null;
}
