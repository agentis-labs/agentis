import { describe, expect, it } from 'vitest';
import { validateExtensionSource } from '../../src/extensions/validateSource.js';

describe('validateExtensionSource', () => {
  it('accepts a valid ESM-style operation function', () => {
    const result = validateExtensionSource(
      `export async function scrape(inputs, ctx) {
         const res = await ctx.http.fetch('https://example.com/' + inputs.handle);
         return { ok: res.ok };
       }`,
      ['scrape'],
    );
    expect(result.ok).toBe(true);
  });

  it('rejects CommonJS require — the real "require is not defined" failure class', () => {
    const result = validateExtensionSource(
      `const crypto = require('crypto');
       export async function execute(inputs, ctx) { return { id: crypto.randomUUID() }; }`,
      ['execute'],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issue.code).toBe('EXTENSION_SOURCE_INVALID');
    expect(result.issue.construct).toBe('require(...)');
    expect(result.issue.remediation).toMatch(/ctx\.http\.fetch/);
  });

  it('rejects bare ESM imports', () => {
    const result = validateExtensionSource(
      `import fetch from 'node-fetch';
       export async function execute(inputs, ctx) { return {}; }`,
      ['execute'],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issue.construct).toBe('import ... from');
  });

  it('rejects module.exports', () => {
    const result = validateExtensionSource(
      `async function execute(inputs, ctx) { return {}; }
       module.exports = { execute };`,
      ['execute'],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issue.construct).toBe('module.exports');
  });

  it('rejects process.env access', () => {
    const result = validateExtensionSource(
      `export async function execute(inputs, ctx) { return { key: process.env.SECRET }; }`,
      ['execute'],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issue.construct).toBe('process.*');
  });

  it('rejects a syntax error before it can crash a live run', () => {
    const result = validateExtensionSource(
      `export async function execute(inputs, ctx) { return { `,
      ['execute'],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issue.code).toBe('EXTENSION_SOURCE_INVALID');
    expect(result.issue.message).toMatch(/does not compile/);
  });

  it('rejects source that declares no entrypoint', () => {
    const result = validateExtensionSource(
      `const helper = (x) => x * 2;`,
      ['scrape'],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issue.code).toBe('EXTENSION_ENTRYPOINT_MISSING');
  });

  it('accepts a const-arrow entrypoint and an execute fallback', () => {
    expect(validateExtensionSource(`const scrape = async (inputs, ctx) => ({ ok: true });`, ['scrape']).ok).toBe(true);
    expect(validateExtensionSource(`async function execute(inputs) { return {}; }`, ['somethingElse']).ok).toBe(true);
  });
});
