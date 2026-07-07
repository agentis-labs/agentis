import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SpawnTarget {
  command: string;
  args: string[];
}

function dedupe(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const normalized = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

function existing(entries: Array<string | null | undefined>): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .filter((entry) => existsSync(entry));
}

function msysPathToWindows(value: string): string | null {
  const match = value.match(/^\/([a-zA-Z])\/(.*)$/);
  if (!match) return null;
  return `${match[1]!.toUpperCase()}:\\${match[2]!.replace(/\//g, '\\')}`;
}

function quotedValue(value: string): string | null {
  const single = value.match(/'([^']*)'/)?.[1];
  if (single !== undefined) return single;
  const double = value.match(/"([^"]*)"/)?.[1];
  return double ?? null;
}

function claudeShellSnapshotPathCandidates(userProfile: string): string[] {
  const snapshotDir = path.join(userProfile, '.claude', 'shell-snapshots');
  if (!existsSync(snapshotDir)) return [];
  try {
    return readdirSync(snapshotDir)
      .filter((entry) => entry.endsWith('.sh'))
      .flatMap((entry) => {
        try {
          const content = readFileSync(path.join(snapshotDir, entry), 'utf8');
          const pathLine = content.split(/\r?\n/).find((line) => line.startsWith('export PATH='));
          const rawPath = pathLine ? quotedValue(pathLine) : null;
          if (!rawPath) return [];
          return rawPath
            .split(':')
            .map((part) => msysPathToWindows(part) ?? part)
            .filter((part) => path.isAbsolute(part));
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function currentPathEntries(env: NodeJS.ProcessEnv): string[] {
  const key = pathEnvKey(env);
  const raw = env[key] ?? env.PATH ?? env.Path ?? '';
  return raw.split(path.delimiter).filter(Boolean);
}

function windowsPreferredCandidates(env: NodeJS.ProcessEnv): string[] {
  const userProfile = env.USERPROFILE ?? os.homedir();
  const localAppData = env.LOCALAPPDATA ?? path.join(userProfile, 'AppData', 'Local');
  return existing([
    // Codex Desktop exposes a stable, user-writable CLI here. Prefer it over
    // versioned WindowsApps package paths, which can exist but fail with EPERM.
    path.join(localAppData, 'OpenAI', 'Codex', 'bin'),
  ]);
}

function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const userProfile = env.USERPROFILE ?? os.homedir();
  const appData = env.APPDATA ?? path.join(userProfile, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA ?? path.join(userProfile, 'AppData', 'Local');
  const npmPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  const systemRoot = env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  const programData = env.ProgramData ?? process.env.ProgramData ?? 'C:\\ProgramData';
  return existing([
    path.join(systemRoot, 'System32'),
    systemRoot,
    path.join(systemRoot, 'System32', 'Wbem'),
    npmPrefix,
    path.join(appData, 'npm'),
    path.join(appData, 'npm', 'node_modules', '.bin'),
    path.join(localAppData, 'npm'),
    path.join(userProfile, 'AppData', 'Roaming', 'npm'),
    path.join(localAppData, 'pnpm'),
    path.join(appData, 'pnpm'),
    path.join(localAppData, 'Microsoft', 'WindowsApps'),
    path.join(userProfile, '.local', 'bin'),
    path.join(userProfile, '.npm-global'),
    path.join(userProfile, '.npm-global', 'bin'),
    path.join(userProfile, '.volta', 'bin'),
    path.join(userProfile, '.bun', 'bin'),
    path.join(userProfile, '.cargo', 'bin'),
    path.join(userProfile, '.claude', 'local'),
    path.join(userProfile, '.claude', 'local', 'node_modules', '.bin'),
    path.join(userProfile, '.codex', 'bin'),
    path.join(userProfile, 'scoop', 'shims'),
    path.join(programData, 'chocolatey', 'bin'),
    path.join(localAppData, 'Programs', 'nodejs'),
    'C:\\Program Files\\nodejs',
    ...claudeShellSnapshotPathCandidates(userProfile),
  ]);
}

function unixCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? os.homedir();
  const nvmDir = env.NVM_DIR ?? path.join(home, '.nvm');
  const npmPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
  let nvmActiveBin: string | null = null;
  if (existsSync(nvmVersionsDir)) {
    try {
      const versions = dedupe(readdirSync(nvmVersionsDir).map((entry) => path.join(nvmVersionsDir, entry, 'bin')));
      nvmActiveBin = versions.find((entry) => existsSync(entry)) ?? null;
    } catch {
      nvmActiveBin = null;
    }
  }
  return existing([
    npmPrefix ? path.join(npmPrefix, 'bin') : null,
    npmPrefix,
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    '/usr/local/bin',
    path.join(home, '.volta', 'bin'),
    nvmActiveBin,
    '/opt/homebrew/bin',
  ]);
}

export function pathEnvKey(env: NodeJS.ProcessEnv = process.env): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? (process.platform === 'win32' ? 'Path' : 'PATH');
}

export function defaultPathForPlatform(): string {
  if (process.platform === 'win32') return 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem';
  return '/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin';
}

export function buildExpandedPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = currentPathEntries(env);
  const fallback = base.length > 0 ? [] : defaultPathForPlatform().split(path.delimiter);
  const preferred = process.platform === 'win32' ? windowsPreferredCandidates(env) : [];
  const candidates = process.platform === 'win32' ? windowsCandidates(env) : unixCandidates(env);
  return dedupe([...preferred, ...base, ...fallback, ...candidates]).join(path.delimiter);
}

export function expandedPathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  return buildExpandedPath(env).split(path.delimiter).filter(Boolean);
}

export function withExpandedPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const expanded = buildExpandedPath(env);
  const key = pathEnvKey(env);
  const next: NodeJS.ProcessEnv = { ...env, [key]: expanded, PATH: expanded };
  if (process.platform === 'win32') next.Path = expanded;
  return next;
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
}

function pathExists(candidate: string): boolean {
  try {
    accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCommandPath(command: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  const expandedEnv = withExpandedPath(env);
  const hasPathSeparator = command.includes('/') || command.includes('\\');
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return pathExists(absolute) ? absolute : null;
  }

  const pathValue = expandedEnv.PATH ?? expandedEnv.Path ?? '';
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? windowsPathExts(expandedEnv) : [''];
  const hasExtension = process.platform === 'win32' && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates = process.platform === 'win32'
      ? hasExtension
        ? [path.join(dir, command)]
        : exts.map((ext) => path.join(dir, `${command}${ext}`))
      : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (pathExists(candidate)) return candidate;
    }
  }

  return null;
}

function resolveWindowsCmdShell(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'cmd.exe');
}

export function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): SpawnTarget {
  const expandedEnv = withExpandedPath(env);
  const resolved = resolveCommandPath(command, cwd, expandedEnv);
  const executable = resolved ?? command;

  if (process.platform !== 'win32') return { command: executable, args };

  if (/\.(cmd|bat)$/i.test(executable)) {
    return {
      command: resolveWindowsCmdShell(expandedEnv),
      args: ['/d', '/s', '/c', 'call', executable, ...args],
    };
  }

  return { command: executable, args };
}

/**
 * Resolve a SAFE working directory for spawning a child process.
 *
 * On Windows, `child_process.spawn(cmd, args, { cwd })` throws a MISLEADING
 * `Error: spawn <cmd> ENOENT` when `cwd` does not exist — it blames the command
 * (so a present, working binary looks "missing" / the runtime looks "unavailable"),
 * not the absent directory (nodejs/node#7331). Agent harness cwds are long-lived
 * managed/project dirs that can disappear AFTER the adapter was registered — an
 * external cleanup, a deleted project checkout, or OneDrive / Files-On-Demand
 * dehydration — so a cwd that existed at registration is often gone by spawn time.
 * A one-shot `mkdir` at registration cannot cover that. Re-validate (and, for owned
 * agent homes, re-create) the cwd on EVERY spawn so a transient/again-missing
 * directory self-heals instead of surfacing as a phantom binary/runtime failure.
 *
 * - empty/undefined `preferred` → `undefined` (inherit the parent process cwd).
 * - `preferred` is an existing directory → returned unchanged.
 * - missing & `create` → `mkdir -p`; returned on success.
 * - otherwise → nearest existing ancestor, else the parent process cwd, else
 *   `undefined` (inherit rather than force a value we know is bad).
 */
export function resolveSpawnCwd(preferred?: string | null, opts?: { create?: boolean }): string | undefined {
  const value = typeof preferred === 'string' ? preferred.trim() : '';
  if (!value) return undefined;
  if (isDirectory(value)) return value;
  if (opts?.create) {
    try {
      mkdirSync(value, { recursive: true });
      if (isDirectory(value)) return value;
    } catch {
      // Creation can fail (permissions, a file occupying the path, an unavailable
      // drive) — degrade to an existing ancestor rather than re-throwing ENOENT.
    }
  }
  const ancestor = nearestExistingDir(value);
  if (ancestor) return ancestor;
  const parentCwd = safeProcessCwd();
  return parentCwd && isDirectory(parentCwd) ? parentCwd : undefined;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Nearest existing ancestor directory of a (possibly missing) path, or null. */
function nearestExistingDir(start: string): string | null {
  let dir: string;
  try {
    dir = path.dirname(path.isAbsolute(start) ? start : path.resolve(start));
  } catch {
    // path.resolve() calls process.cwd() for a relative path, which itself throws
    // if the server's own cwd was deleted — never let the resolver rethrow that.
    return null;
  }
  for (;;) {
    if (isDirectory(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/** `process.cwd()` throws ENOENT if the server's own cwd was removed — guard it. */
function safeProcessCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/**
 * Resolve the Claude Code binary, self-healing a stale Claude-Desktop version pin.
 *
 * Claude Desktop installs versioned binaries at
 *   <base>/Claude/claude-code/<version>/claude(.exe)
 * and DELETES old version dirs on auto-update. A config that pins one exact
 * version therefore 404s (`spawn … claude.exe ENOENT`) the moment Claude updates —
 * a recurring, self-inflicted outage. When the configured path is one of these
 * managed versioned paths, re-resolve to the NEWEST currently-installed version at
 * call time; if the managed dir is gone entirely, fall back to `claude` on PATH.
 * A NON-managed configured path (a custom binary) is passed through unchanged — we
 * only self-heal the rotating Claude-Desktop paths, never override a deliberate one.
 */
export function resolveClaudeBinary(configured?: string | null): string {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (!value) return 'claude';
  const managed = value.match(/^(.*[\\/]claude-code)[\\/][^\\/]+[\\/](claude(?:\.exe)?)$/i);
  if (managed) {
    const newest = newestManagedClaude(managed[1]!, managed[2]!);
    if (newest) return newest;
    // The pinned version rotated out AND no sibling version remains → PATH.
    return existsSync(value) ? value : 'claude';
  }
  // Non-managed path: pass through unchanged (resolveSpawnTarget resolves it via
  // PATH/cwd), so a deliberately-configured custom binary is never overridden.
  return value;
}

/** The newest-versioned `<baseDir>/<version>/<exeName>` that actually exists. */
function newestManagedClaude(baseDir: string, exeName: string): string | null {
  let versions: string[];
  try {
    versions = readdirSync(baseDir);
  } catch {
    return null;
  }
  const found = versions
    .map((name) => ({ name, exe: path.join(baseDir, name, exeName) }))
    .filter((entry) => existsSync(entry.exe));
  if (found.length === 0) return null;
  found.sort((a, b) => compareVersionDesc(a.name, b.name));
  return found[0]!.exe;
}

/** Descending numeric-dotted version compare (2.1.197 before 2.1.187 before 2.1.9). */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const xi = Number.parseInt(pa[i] ?? '0', 10);
    const yi = Number.parseInt(pb[i] ?? '0', 10);
    const x = Number.isFinite(xi) ? xi : 0;
    const y = Number.isFinite(yi) ? yi : 0;
    if (x !== y) return y - x;
  }
  return 0;
}
