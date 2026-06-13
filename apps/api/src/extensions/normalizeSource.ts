/**
 * Strip ES-module `export` keywords from operator extension source so the code
 * can be evaluated as a plain script body inside the isolate / vm context.
 * Shared by the isolated-vm and node:vm runtimes.
 */
export function normalizeExtensionSource(source: string): string {
  return source
    .replace(/\bexport\s+default\s+async\s+function\s+/g, 'async function ')
    .replace(/\bexport\s+default\s+function\s+/g, 'function ')
    .replace(/\bexport\s+async\s+function\s+/g, 'async function ')
    .replace(/\bexport\s+function\s+/g, 'function ')
    .replace(/\bexport\s+const\s+/g, 'const ')
    .replace(/\bexport\s+\{[\s\S]*?\};?/g, '');
}
