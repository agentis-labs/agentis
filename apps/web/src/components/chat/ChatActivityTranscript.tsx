import { useEffect, useMemo, useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import clsx from 'clsx';
import type { ChatDelta, ChatTurnTrace } from '@agentis/core';
import type { ToolCallData } from './toolCalls';

type ChatActivity = Extract<ChatDelta, { type: 'activity' }>;

const MAX_THINKING_ROWS = 4;
const MAX_THINKING_LENGTH = 280;
const LIFECYCLE_NOISE =
  /request received|accepted the chat turn|preparing your request|loading workspace context|collecting viewport|agent instructions|invoking agent runtime|chat harness|waiting for (?:model output|runtime)|runtime pass|still working|building the workflow|build blocked|extension created|canvas context|workflow ready/i;

function compactThinking(text: string): string[] {
  return text
    .trim()
    .split(/\r?\n{2,}|\r?\n(?=[-*\u2022])|(?<=[.!?])\s+(?=[A-Z])/)
    .map((line) => line.replace(/^\s*[-*\u2022]\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 2 && !LIFECYCLE_NOISE.test(line))
    .slice(-MAX_THINKING_ROWS)
    .map((line) => line.length > MAX_THINKING_LENGTH
      ? `${line.slice(0, MAX_THINKING_LENGTH - 3).trimEnd()}...`
      : line);
}

function LoadingDots() {
  return (
    <span
      className="chat-loading-dots"
      role="status"
      aria-label="Working"
      data-testid="chat-loading-dots"
    >
      <span />
      <span />
      <span />
    </span>
  );
}

export function ChatActivityTranscript({
  activities: _activities = [],
  toolCalls: _toolCalls = [],
  thinking = '',
  turn: _turn,
  streaming,
  failed: _failed = false,
  successfulArtifact: _successfulArtifact = false,
}: {
  activities?: ChatActivity[];
  toolCalls?: ToolCallData[];
  thinking?: string;
  turn?: ChatTurnTrace;
  streaming: boolean;
  failed?: boolean;
  successfulArtifact?: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const thoughts = useMemo(() => compactThinking(thinking), [thinking]);

  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  if (streaming && thoughts.length === 0) {
    return (
      <div className="mb-2.5 flex min-h-5 items-center px-0.5" data-testid="chat-activity-loading">
        <LoadingDots />
      </div>
    );
  }
  if (thoughts.length === 0) return null;

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="mb-2.5 w-full"
      data-testid="chat-activity-transcript"
    >
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 py-0.5 text-left text-[12px] text-text-secondary transition-colors hover:text-text-primary active:scale-[0.99]"
          aria-label={open ? 'Collapse thinking' : 'Expand thinking'}
        >
          <Brain size={13} className="shrink-0 text-accent" />
          <span className="font-medium">Thinking</span>
          {streaming && <LoadingDots />}
          <span className="ml-auto text-text-muted">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </button>
      </Collapsible.Trigger>

      <Collapsible.Content className="overflow-hidden">
        <div className="ml-1.5 mt-2 border-l border-line/45 pl-4">
          <div className="space-y-2">
            {thoughts.map((thought, index) => (
              <p
                key={`${index}:${thought.slice(0, 36)}`}
                className={clsx('text-[12px] leading-[1.55] text-text-secondary')}
              >
                {thought}
              </p>
            ))}
          </div>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
