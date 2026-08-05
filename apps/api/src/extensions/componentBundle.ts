import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AgentisError, type ComponentManifestV2 } from '@agentis/core';
import { resolveDefaultDataDir } from '../defaultDataDir.js';

const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 5_000;

export interface InstalledComponentBundle {
  bundleDir: string;
  bundleHash: string;
  fileCount: number;
  totalBytes: number;
  created: boolean;
}

export interface PortableComponentBundleFile {
  path: string;
  sha256: string;
  dataBase64: string;
}

export function validateComponentManifest(manifest: ComponentManifestV2): void {
  if (manifest.manifestVersion !== 2) throw new AgentisError('VALIDATION_FAILED', 'component manifestVersion must be 2');
  if (!manifest.id.trim() || !manifest.version.trim()) throw new AgentisError('VALIDATION_FAILED', 'component id and version are required');
  if (manifest.runtime.language === 'python' && manifest.runtime.version !== '3.12') {
    throw new AgentisError('VALIDATION_FAILED', 'component runtime supports Python 3.12 in v2');
  }
  if (manifest.runtime.language === 'node' && manifest.runtime.version !== '20') {
    throw new AgentisError('VALIDATION_FAILED', 'component runtime supports Node 20 in v2');
  }
  assertRelativeFile(manifest.entrypoint, 'entrypoint');
  assertRelativeFile(manifest.dependencyLock, 'dependencyLock');
  if (manifest.operations.length === 0) throw new AgentisError('VALIDATION_FAILED', 'component requires at least one operation');
  if (!(manifest.resources.cpu > 0 && manifest.resources.cpu <= 8)) throw new AgentisError('VALIDATION_FAILED', 'component cpu must be within (0, 8]');
  if (!(manifest.resources.memoryMb >= 32 && manifest.resources.memoryMb <= 8192)) throw new AgentisError('VALIDATION_FAILED', 'component memoryMb must be 32..8192');
  if (!(manifest.resources.timeoutSec >= 1 && manifest.resources.timeoutSec <= 3600)) throw new AgentisError('VALIDATION_FAILED', 'component timeoutSec must be 1..3600');
}

export function inspectComponentBundle(sourceDir: string): { hash: string; fileCount: number; totalBytes: number } {
  const root = path.resolve(sourceDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new AgentisError('VALIDATION_FAILED', 'component bundleDir must be an existing directory');
  const files = walk(root);
  if (files.length === 0 || files.length > MAX_FILES) throw new AgentisError('VALIDATION_FAILED', `component bundle must contain 1..${MAX_FILES} files`);
  const hash = createHash('sha256');
  let totalBytes = 0;
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const stats = statSync(file);
    totalBytes += stats.size;
    if (totalBytes > MAX_BUNDLE_BYTES) throw new AgentisError('VALIDATION_FAILED', 'component bundle exceeds 100MB');
    hash.update(relative).update('\0').update(readFileSync(file)).update('\0');
  }
  return { hash: hash.digest('hex'), fileCount: files.length, totalBytes };
}

export function installComponentBundle(sourceDir: string, manifest: ComponentManifestV2): InstalledComponentBundle {
  validateComponentManifest(manifest);
  const source = path.resolve(sourceDir);
  for (const relative of [manifest.entrypoint, manifest.dependencyLock]) {
    if (!existsSync(path.join(source, relative))) throw new AgentisError('VALIDATION_FAILED', `component bundle is missing ${relative}`);
  }
  const inspected = inspectComponentBundle(source);
  if (manifest.bundleHash && manifest.bundleHash !== inspected.hash) {
    throw new AgentisError('VALIDATION_FAILED', `component bundle hash mismatch: expected ${manifest.bundleHash}, got ${inspected.hash}`);
  }
  const root = path.resolve(process.env.AGENTIS_DATA_DIR?.trim() || resolveDefaultDataDir(), 'components');
  mkdirSync(root, { recursive: true });
  const target = path.join(root, inspected.hash);
  if (existsSync(target)) return verifiedExistingBundle(target, inspected.hash);
  const temporary = `${target}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  cpSync(source, temporary, { recursive: true, errorOnExist: true, verbatimSymlinks: false });
  renameSync(temporary, target);
  return { bundleDir: target, bundleHash: inspected.hash, fileCount: inspected.fileCount, totalBytes: inspected.totalBytes, created: true };
}

/** Install a Component v2 bundle supplied over HTTP/MCP without trusting a host path. */
export function installPortableComponentBundle(
  bundleFiles: PortableComponentBundleFile[],
  manifest: ComponentManifestV2,
): InstalledComponentBundle {
  validateComponentManifest(manifest);
  if (bundleFiles.length === 0 || bundleFiles.length > MAX_FILES) {
    throw new AgentisError('VALIDATION_FAILED', `component bundle must contain 1..${MAX_FILES} files`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const decoded = bundleFiles.map((file) => {
    const relative = portablePath(file.path);
    if (seen.has(relative)) throw new AgentisError('VALIDATION_FAILED', `component bundle contains duplicate file ${relative}`);
    seen.add(relative);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new AgentisError('VALIDATION_FAILED', `component file ${relative} has an invalid sha256`);
    }
    const data = decodeBase64(file.dataBase64, relative);
    totalBytes += data.length;
    if (totalBytes > MAX_BUNDLE_BYTES) throw new AgentisError('VALIDATION_FAILED', 'component bundle exceeds 100MB');
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== file.sha256) throw new AgentisError('VALIDATION_FAILED', `component file checksum mismatch: ${relative}`);
    return { path: relative, data };
  }).sort((a, b) => comparePath(a.path, b.path));
  for (const required of [portablePath(manifest.entrypoint), portablePath(manifest.dependencyLock)]) {
    if (!seen.has(required)) throw new AgentisError('VALIDATION_FAILED', `component bundle is missing ${required}`);
  }
  const aggregate = createHash('sha256');
  for (const file of decoded) aggregate.update(file.path).update('\0').update(file.data).update('\0');
  const bundleHash = aggregate.digest('hex');
  if (manifest.bundleHash && manifest.bundleHash !== bundleHash) {
    throw new AgentisError('VALIDATION_FAILED', `component bundle hash mismatch: expected ${manifest.bundleHash}, got ${bundleHash}`);
  }

  const root = path.resolve(process.env.AGENTIS_DATA_DIR?.trim() || resolveDefaultDataDir(), 'components');
  mkdirSync(root, { recursive: true });
  const target = path.join(root, bundleHash);
  if (existsSync(target)) return verifiedExistingBundle(target, bundleHash);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(temporary, { recursive: true });
  try {
    for (const file of decoded) {
      const destination = path.resolve(temporary, file.path);
      if (!destination.startsWith(`${path.resolve(temporary)}${path.sep}`)) {
        throw new AgentisError('VALIDATION_FAILED', `unsafe component destination ${file.path}`);
      }
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, file.data, { flag: 'wx' });
    }
    try {
      renameSync(temporary, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
      rmSync(temporary, { recursive: true, force: true });
      return verifiedExistingBundle(target, bundleHash);
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return { bundleDir: target, bundleHash, fileCount: decoded.length, totalBytes, created: true };
}

function walk(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => comparePath(a.name, b.name))) {
      const absolute = path.join(directory, entry.name);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) throw new AgentisError('VALIDATION_FAILED', `component bundle cannot contain symlink ${path.relative(root, absolute)}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  };
  visit(root);
  return output;
}

/** Locale-independent ordering keeps the content hash identical on every host. */
function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function verifiedExistingBundle(target: string, expectedHash: string): InstalledComponentBundle {
  const inspected = inspectComponentBundle(target);
  if (inspected.hash !== expectedHash) {
    throw new AgentisError('VALIDATION_FAILED', `installed component bundle ${expectedHash} is corrupted`);
  }
  return {
    bundleDir: target,
    bundleHash: expectedHash,
    fileCount: inspected.fileCount,
    totalBytes: inspected.totalBytes,
    created: false,
  };
}

function assertRelativeFile(value: string, field: string): void {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]+/).includes('..')) {
    throw new AgentisError('VALIDATION_FAILED', `component ${field} must be a safe relative path`);
  }
}

function portablePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new AgentisError('VALIDATION_FAILED', `unsafe component bundle path ${value}`);
  }
  return normalized;
}

function decodeBase64(value: string, relative: string): Buffer {
  const compact = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new AgentisError('VALIDATION_FAILED', `component file ${relative} has invalid base64 data`);
  }
  return Buffer.from(compact, 'base64');
}
