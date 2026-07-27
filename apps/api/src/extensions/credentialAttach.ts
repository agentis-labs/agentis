/**
 * Attach a resolved credential to outgoing extension-sandbox fetch headers
 * (INTEGRATION-CEILING-10X §3).
 *
 * The sandboxed script references a credential ONLY by the author-declared key
 * name (`ctx.http.fetch(url, {credential: 'instagram_token'})`) — it never sees
 * the decrypted value. This function runs in trusted HOST code, resolves the
 * key against the map the caller built from the operator's credentialBindings
 * (extensionRuntime.ts), and merges the real header in. Mirrors the same
 * "declare a reference, host attaches the value" pattern MCP already uses
 * (mcpToolBridge.ts) for external server credentials.
 */

import { AgentisError } from '@agentis/core';

export interface ResolvedExtensionCredential {
  /** The decrypted secret value. */
  value: string;
  /** Header to place it in; defaults to 'authorization'. */
  headerName?: string;
  /** Value template; `{value}` is replaced with the secret. Defaults to `Bearer {value}`. */
  headerTemplate?: string;
}

/**
 * Merge a declaratively-referenced credential into request headers. Throws if
 * the extension asks for a credential key that isn't in the resolved map (not
 * declared in the manifest, or not bound by the operator) — fails closed.
 */
export function attachExtensionCredential(
  headers: Record<string, string>,
  credentialKey: string | undefined,
  resolved: Record<string, ResolvedExtensionCredential>,
): void {
  if (!credentialKey) return;
  const entry = resolved[credentialKey];
  if (!entry) {
    throw new AgentisError(
      'EXTENSION_PERMISSION_DENIED',
      `credential "${credentialKey}" is not available — it must be declared in the manifest's credentialKeys AND bound to a real credential by the operator`,
    );
  }
  const headerName = (entry.headerName ?? 'authorization').toLowerCase();
  const template = entry.headerTemplate ?? 'Bearer {value}';
  headers[headerName] = template.replace('{value}', entry.value);
}
