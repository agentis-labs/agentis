/**
 * connectorReadiness / connectorCatalog — honest connector catalog (masterplan 2.2).
 *
 * Distinguishes connectors that run out of the box (hand-written or templated)
 * from ones that fall back to generic HTTP and need operator setup, so the UI
 * never advertises a connector as ready when it would throw on first use.
 */
import { describe, it, expect } from 'vitest';
import { connectorReadiness, connectorCatalog } from '../src/registry.js';

describe('connectorReadiness', () => {
  it('marks a hand-written connector as runnable', () => {
    expect(connectorReadiness('github')).toBe('runnable');
    expect(connectorReadiness('slack')).toBe('runnable');
  });

  it('marks a templated connector as runnable', () => {
    expect(connectorReadiness('stripe')).toBe('runnable');
    expect(connectorReadiness('notion')).toBe('runnable');
  });

  it('marks a manifest-only connector with no template as needs_setup', () => {
    expect(connectorReadiness('salesforce')).toBe('needs_setup');
    expect(connectorReadiness('mongodb')).toBe('needs_setup');
  });
});

describe('connectorCatalog', () => {
  it('tags every advertised connector and contains a mix of both states', () => {
    const catalog = connectorCatalog();
    expect(catalog.length).toBeGreaterThan(20);
    const byService = Object.fromEntries(catalog.map((c) => [c.service, c.readiness]));
    expect(byService['github']).toBe('runnable');
    expect(byService['salesforce']).toBe('needs_setup');
    // Both classes are represented — the catalog is honest, not all-green.
    expect(catalog.some((c) => c.readiness === 'runnable')).toBe(true);
    expect(catalog.some((c) => c.readiness === 'needs_setup')).toBe(true);
    // Entries carry the display metadata the UI needs.
    const gh = catalog.find((c) => c.service === 'github')!;
    expect(gh).toMatchObject({ name: expect.any(String), category: expect.any(String), operations: expect.any(Array) });
  });
});
