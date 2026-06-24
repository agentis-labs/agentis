import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAutoScroll } from '../../src/hooks/useAutoScroll';

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];

  callback: ResizeObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function AutoScrollHarness({ messageCount = 1 }: { messageCount?: number }) {
  const { scrollRef } = useAutoScroll(messageCount, false);
  return (
    <div ref={scrollRef}>
      <div>message</div>
    </div>
  );
}

describe('useAutoScroll', () => {
  it('re-pins to the bottom when the scroll container itself resizes', () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    const { container } = render(<AutoScrollHarness />);
    const scrollEl = container.firstElementChild as HTMLDivElement;
    const scrollTo = vi.fn();
    let scrollTop = 0;

    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, get: () => 640 });
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, get: () => 280 });
    Object.defineProperty(scrollEl, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });
    Object.defineProperty(scrollEl, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });

    act(() => {
      MockResizeObserver.instances[0]?.trigger();
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 640, behavior: 'auto' });
  });

  it('does not yank the thread to the bottom after the user scrolls up', () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    const { container } = render(<AutoScrollHarness />);
    const scrollEl = container.firstElementChild as HTMLDivElement;
    const scrollTo = vi.fn();
    let scrollTop = 120;

    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, get: () => 640 });
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, get: () => 280 });
    Object.defineProperty(scrollEl, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });
    Object.defineProperty(scrollEl, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });

    act(() => {
      scrollEl.dispatchEvent(new Event('scroll'));
    });

    act(() => {
      MockResizeObserver.instances[0]?.trigger();
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
