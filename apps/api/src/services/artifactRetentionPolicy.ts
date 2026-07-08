export interface ArtifactRetentionPolicy {
  mode?: 'intentional' | 'all' | 'none';
  saveScreenshots?: boolean;
  saveGeneratedAssets?: boolean;
}

export function artifactPolicyFromUnknown(value: unknown): ArtifactRetentionPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: ArtifactRetentionPolicy = {};
  if (input.mode === 'intentional' || input.mode === 'all' || input.mode === 'none') out.mode = input.mode;
  if (typeof input.saveScreenshots === 'boolean') out.saveScreenshots = input.saveScreenshots;
  if (typeof input.saveGeneratedAssets === 'boolean') out.saveGeneratedAssets = input.saveGeneratedAssets;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function shouldPersistScreenshot(args: Record<string, unknown>, policy?: ArtifactRetentionPolicy | null): boolean {
  if (policy?.mode === 'none') return false;
  if (explicitBoolean(args, 'save') ?? explicitBoolean(args, 'persist') ?? explicitBoolean(args, 'store')) return true;
  if (explicitBoolean(args, 'save') === false || explicitBoolean(args, 'persist') === false || explicitBoolean(args, 'store') === false) {
    return false;
  }
  return policy?.mode === 'all' || policy?.saveScreenshots === true || policy?.saveGeneratedAssets === true;
}

function explicitBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? args[key] : undefined;
}
