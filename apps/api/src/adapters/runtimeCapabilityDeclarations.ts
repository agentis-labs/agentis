import {
  BUILTIN_RUNTIME_CAPABILITIES,
  type RuntimeCapabilityDeclaration,
  type RuntimeCapabilityId,
} from '@agentis/core';

export interface RuntimeCapabilityDeclarationOptions {
  /** Capability-contract revision implemented by this adapter. */
  version?: string;
  /** Optional per-capability operational limits. */
  limits?: Partial<Record<RuntimeCapabilityId, Record<string, string | number | boolean>>>;
  /** Third-party/native capabilities beyond Agentis built-ins. */
  additional?: RuntimeCapabilityDeclaration[];
}

/**
 * Build a complete, adapter-authored capability declaration.
 *
 * Every Agentis built-in is advertised explicitly, including unavailable
 * powers. This prevents a legacy boolean projection from accidentally granting
 * a capability merely because a transport or adjacent affordance is present.
 */
export function nativeRuntimeCapabilities(
  available: readonly RuntimeCapabilityId[],
  options: RuntimeCapabilityDeclarationOptions = {},
): RuntimeCapabilityDeclaration[] {
  const enabled = new Set(available);
  const version = options.version ?? '1';
  const declarations = new Map<RuntimeCapabilityId, RuntimeCapabilityDeclaration>();

  for (const id of BUILTIN_RUNTIME_CAPABILITIES) {
    declarations.set(id, {
      id,
      available: enabled.has(id),
      source: 'advertised',
      version,
      ...(options.limits?.[id] ? { limits: options.limits[id] } : {}),
    });
  }
  for (const declaration of options.additional ?? []) {
    declarations.set(declaration.id, {
      ...declaration,
      source: 'advertised',
      version: declaration.version ?? version,
    });
  }

  return [...declarations.values()];
}
