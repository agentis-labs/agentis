import { describe, expect, it } from 'vitest';
import { parseChatPermissionDirective } from '../src/chatModeDirective.js';

describe('parseChatPermissionDirective', () => {
  it('accepts leading and trailing standalone permission commands', () => {
    expect(parseChatPermissionDirective('/plan build it')).toEqual({ mode: 'plan', rest: 'build it' });
    expect(parseChatPermissionDirective('build it\n/plan')).toEqual({ mode: 'plan', rest: 'build it' });
    expect(parseChatPermissionDirective('continue\n/auto')).toEqual({ mode: 'auto', rest: 'continue' });
  });

  it('does not reinterpret an inline command mention', () => {
    expect(parseChatPermissionDirective('Explain how /plan works')).toBeNull();
  });
});
