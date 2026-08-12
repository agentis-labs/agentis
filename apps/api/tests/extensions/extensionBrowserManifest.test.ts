import { describe, expect, it } from 'vitest';
import type { ExtensionManifest, ExtensionPermission } from '@agentis/core';
import { validateExtensionManifest } from '../../src/services/extensionRuntime.js';

describe('extension browser manifest contract', () => {
  it('requires allowedDomains for browser access', () => {
    expect(() => validateExtensionManifest(manifest(['browser'], []), { install: true }))
      .toThrow(/browser.*allowedDomains/i);
  });

  it.each(['browser.evaluate', 'browser.session.persist', 'browser.auth'] as const)(
    'requires browser when %s is declared',
    (permission) => {
      expect(() => validateExtensionManifest(manifest([permission], ['example.com']), { install: true }))
        .toThrow(/requires the browser permission/i);
    },
  );

  it('accepts the complete browser permission contract', () => {
    expect(() => validateExtensionManifest(manifest([
      'browser',
      'browser.evaluate',
      'browser.session.persist',
      'browser.auth',
    ], ['example.com']), { install: true })).not.toThrow();
  });
});

function manifest(permissions: ExtensionPermission[], allowedDomains: string[]): ExtensionManifest {
  return {
    name: 'Browser extension',
    slug: 'browser-extension',
    version: '1.0.0',
    runtime: 'node_worker',
    source: 'export async function run() { return {}; }',
    operations: [{ name: 'run', inputSchema: {}, outputSchema: {} }],
    permissions,
    allowedDomains,
    capabilityTags: ['browser'],
  };
}
