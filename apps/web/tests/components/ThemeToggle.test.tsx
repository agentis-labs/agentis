import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ThemeToggle } from '../../src/components/shared/ThemeToggle';

type MatchMediaController = {
  setMatches: (next: boolean) => void;
};

function mockMatchMedia(initial: boolean): MatchMediaController {
  let matches = initial;
  const listeners = new Set<() => void>();

  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: light)',
    onchange: null,
    addEventListener: (_: 'change', cb: () => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_: 'change', cb: () => void) => {
      listeners.delete(cb);
    },
    addListener: (cb: () => void) => {
      listeners.add(cb);
    },
    removeListener: (cb: () => void) => {
      listeners.delete(cb);
    },
    dispatchEvent: () => true,
  })));

  return {
    setMatches(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb());
    },
  };
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.style.colorScheme = '';
  });

  it('switches root theme to light and persists preference', () => {
    mockMatchMedia(false);
    render(<ThemeToggle variant="full" />);

    fireEvent.click(screen.getByRole('button', { name: /light/i }));

    expect(localStorage.getItem('agentis.theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('tracks system theme changes when set to system', () => {
    const media = mockMatchMedia(true);
    localStorage.setItem('agentis.theme', 'system');

    render(<ThemeToggle variant="full" />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    act(() => {
      media.setMatches(false);
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});
