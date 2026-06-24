/**
 * Static validation gate for node_worker extension source.
 *
 * The extension sandbox (isolated-vm / node:vm) provides NO module system: there
 * is no `require`, no bare `import`, no `module.exports`, no `process`. Generated
 * or hand-written extensions that use CommonJS/ESM module syntax therefore crash
 * at run time with `ReferenceError: require is not defined` — a failure class the
 * old preflight could never see because it MOCKED extension nodes instead of
 * looking at their code.
 *
 * This validator catches that class deterministically and in microseconds, with
 * no execution and no I/O. It is the single source of truth used at BOTH:
 *   - extension creation (`extensionLibrary.createNodeWorkerExtension`), so a
 *     broken extension can never be persisted, and
 *   - workflow preflight (`workflowPreflight`), so a graph that binds a broken
 *     extension can never be reported healthy.
 *
 * Checks, in order:
 *   1. Module-system lint — reject `require(`, bare `import`, `module.exports`,
 *      `exports.`, and `process.` with the offending construct + the ESM fix.
 *   2. Compile — wrap exactly as the runtimes do and `new vm.Script(...)` so a
 *      syntax error is caught here, not on the live run.
 *   3. Entrypoint presence — the normalized source must declare a binding that
 *      the runtime's entrypoint resolution will find (an operation-named
 *      function, or `execute`, or `main`).
 *
 * Mirrors the runtime contract in `nodeWorkerRuntime.ts` / `vmRuntime.ts`; keep
 * the entrypoint logic here in sync with that wrapper.
 */

import vm from 'node:vm';
import { normalizeExtensionSource } from './normalizeSource.js';

export interface ExtensionSourceIssue {
  /** Stable code so callers (creation gate, preflight) can branch deterministically. */
  code: 'EXTENSION_SOURCE_INVALID' | 'EXTENSION_ENTRYPOINT_MISSING';
  message: string;
  /** The offending token/construct, when the failure is a specific syntax form. */
  construct?: string;
  remediation: string;
}

export type ExtensionSourceValidation =
  | { ok: true; normalized: string }
  | { ok: false; issue: ExtensionSourceIssue };

/** A valid JS identifier that the runtime would expose as an operation binding. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface BlockedConstruct {
  pattern: RegExp;
  label: string;
  remediation: string;
}

/**
 * Module-system constructs the sandbox cannot provide. Each maps to the ESM-style
 * remediation the runtime DOES support (top-level `async function name(inputs, ctx)`
 * with `ctx.http.fetch`, no imports).
 */
const BLOCKED_CONSTRUCTS: ReadonlyArray<BlockedConstruct> = [
  {
    pattern: /\brequire\s*\(/,
    label: 'require(...)',
    remediation:
      'The extension sandbox has no `require`. Remove CommonJS imports; use the injected `ctx.http.fetch` for network and built-in globals (JSON, Math, Date, URL, TextEncoder).',
  },
  {
    pattern: /\bmodule\s*\.\s*exports\b/,
    label: 'module.exports',
    remediation:
      'The sandbox has no `module`. Define a top-level `async function <operationName>(inputs, ctx)` instead of assigning to `module.exports`.',
  },
  {
    pattern: /^\s*exports\s*\./m,
    label: 'exports.',
    remediation:
      'The sandbox has no `exports`. Define a top-level `async function <operationName>(inputs, ctx)` instead of assigning to `exports`.',
  },
  {
    // Bare ESM import STATEMENT (`import x from 'y'` / `import 'y'` / `import {a} from 'y'`).
    // The dynamic `import(` form is separately blocked by the runtime; both are unsupported.
    pattern: /^\s*import\s+(?:[^;'"]*\bfrom\b\s*)?['"][^'"]+['"]/m,
    label: 'import ... from',
    remediation:
      'The sandbox cannot import modules. Remove the import and use injected globals + `ctx.http.fetch`.',
  },
  {
    pattern: /\bimport\s*\(/,
    label: 'import(...)',
    remediation: 'Dynamic `import()` is not available in the sandbox. Remove it and use injected globals + `ctx.http.fetch`.',
  },
  {
    pattern: /\bprocess\s*\.\s*[A-Za-z_$]/,
    label: 'process.*',
    remediation:
      'The sandbox has no `process`. Read configuration from the operation `inputs` (mapped from the node) instead of `process.env`.',
  },
];

/**
 * Validate extension source against the sandbox runtime contract. Pure and
 * synchronous — safe to call on every preflight.
 */
export function validateExtensionSource(
  source: string,
  operationNames: string[],
): ExtensionSourceValidation {
  const normalized = normalizeExtensionSource(source);

  for (const blocked of BLOCKED_CONSTRUCTS) {
    if (blocked.pattern.test(normalized)) {
      return {
        ok: false,
        issue: {
          code: 'EXTENSION_SOURCE_INVALID',
          message: `Extension source uses \`${blocked.label}\`, which the extension sandbox does not provide.`,
          construct: blocked.label,
          remediation: blocked.remediation,
        },
      };
    }
  }

  // Compile-check: wrap as an async function body exactly like the runtimes do so
  // a syntax error surfaces here rather than on the live run.
  try {
    // eslint-disable-next-line no-new
    new vm.Script(`(async function(){\n${normalized}\n})`, { filename: 'extension-source-check.js' });
  } catch (err) {
    return {
      ok: false,
      issue: {
        code: 'EXTENSION_SOURCE_INVALID',
        message: `Extension source does not compile: ${(err as Error).message}`,
        remediation: 'Fix the JavaScript syntax error in the extension source.',
      },
    };
  }

  // Entrypoint presence: the runtime resolves an entrypoint as the first of
  // (a) a function named like one of the declared operations, (b) `execute`,
  // (c) `main`. Require at least one to be declared in the normalized source.
  const candidates = [
    ...operationNames.filter((name) => IDENTIFIER.test(name)),
    'execute',
    'main',
  ];
  if (!candidates.some((name) => declaresCallableBinding(normalized, name))) {
    const opHint = operationNames.find((name) => IDENTIFIER.test(name)) ?? 'execute';
    return {
      ok: false,
      issue: {
        code: 'EXTENSION_ENTRYPOINT_MISSING',
        message: `Extension source declares no entrypoint for any operation (looked for ${candidates.map((c) => `\`${c}\``).join(', ')}).`,
        remediation: `Declare \`async function ${opHint}(inputs, ctx) { ... }\` at the top level so the runtime can invoke the operation.`,
      },
    };
  }

  return { ok: true, normalized };
}

/**
 * Approximate static check that the normalized source declares a callable binding
 * named `name` — a function declaration or a const/let/var assigned a function or
 * arrow. Mirrors what the runtime's `typeof <name> === 'function'` probe would
 * find. Conservative on the permissive side: a real compile already passed, so a
 * declared name is overwhelmingly the entrypoint the runtime will call.
 */
function declaresCallableBinding(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\b(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`),
  ];
  return patterns.some((pattern) => pattern.test(source));
}
