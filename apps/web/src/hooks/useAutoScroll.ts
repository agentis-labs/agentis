/**
 * useAutoScroll — smart auto-scroll hook for chat threads.
 *
 * Pins the scroll container to the bottom unless the user has manually
 * scrolled up (≥100px from the bottom edge). Re-locks when a new agent
 * message arrives. Uses a ResizeObserver so scroll tracking works even
 * when message content grows during streaming.
 *
 * Returns:
 *   scrollRef  — attach to the scrollable container div
 *   isAtBottom — whether we're currently pinned to the bottom
 *   scrollToBottom — imperatively scroll to the bottom
 *   suppressNextScroll — call before prepending older messages to prevent
 *                        the auto-scroll from jumping to the bottom
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD = 100; // px from bottom to consider "at bottom"

interface UseAutoScrollOptions {
  /** If true, new agent messages re-lock scroll to bottom. */
  relockOnAgentMessage?: boolean;
}

export function useAutoScroll(
  messageCount: number,
  agentTyping: boolean,
  options: UseAutoScrollOptions = {},
) {
  const { relockOnAgentMessage = true } = options;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const suppressRef = useRef(false);
  const userScrolledRef = useRef(false);
  const prevMessageCountRef = useRef(messageCount);

  const checkBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom < BOTTOM_THRESHOLD;
    setIsAtBottom(atBottom);
    if (atBottom) userScrolledRef.current = false;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    userScrolledRef.current = false;
    setIsAtBottom(true);
  }, []);

  const suppressNextScroll = useCallback(() => {
    suppressRef.current = true;
  }, []);

  // Track user scroll events
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function onScroll() {
      const container = scrollRef.current;
      if (!container) return;
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const atBottom = distFromBottom < BOTTOM_THRESHOLD;
      setIsAtBottom(atBottom);
      if (!atBottom) {
        userScrolledRef.current = true;
      } else {
        userScrolledRef.current = false;
      }
    }

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ResizeObserver: auto-scroll when content height grows (streaming text)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const pinIfAllowed = () => {
      if (suppressRef.current) {
        suppressRef.current = false;
        return;
      }
      if (!userScrolledRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      }
    };

    const observer = new ResizeObserver(() => {
      pinIfAllowed();
    });

    const observeChildren = () => {
      observer.disconnect();
      observer.observe(el);
      for (const child of Array.from(el.children)) {
        observer.observe(child);
      }
    };

    observeChildren();

    const mutationObserver = new MutationObserver(() => {
      observeChildren();
      pinIfAllowed();
    });
    mutationObserver.observe(el, { childList: true });

    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, [messageCount]); // reconnect when message count changes

  // Re-lock on new messages (if user hasn't scrolled up)
  useEffect(() => {
    if (suppressRef.current) {
      suppressRef.current = false;
      prevMessageCountRef.current = messageCount;
      return;
    }

    if (messageCount > prevMessageCountRef.current) {
      if (!userScrolledRef.current) {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        });
      }
    }

    prevMessageCountRef.current = messageCount;
  }, [messageCount]);

  // Re-lock when agent starts typing
  useEffect(() => {
    if (agentTyping && relockOnAgentMessage && !userScrolledRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [agentTyping, relockOnAgentMessage]);

  return { scrollRef, isAtBottom, scrollToBottom, suppressNextScroll };
}
