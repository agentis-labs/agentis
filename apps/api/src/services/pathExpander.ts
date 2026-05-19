import { accessSync, constants as fsConstants, existsSync, readFileSync, readdirSync } from 'node:fs';
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

function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const userProfile = env.USERPROFILE ?? os.homedir();
  const appData = env.APPDATA ?? path.join(userProfile, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA ?? path.join(userProfile, 'AppData', 'Local');
  const npmPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  const systemRoot = env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  return existing([
    path.join(systemRoot, 'System32'),
    systemRoot,
    path.join(systemRoot, 'System32', 'Wbem'),
    npmPrefix,
    path.join(appData, 'npm'),
    path.join(localAppData, 'npm'),
    path.join(userProfile, 'AppData', 'Roaming', 'npm'),
    path.join(localAppData, 'pnpm'),
    path.join(appData, 'pnpm'),
    path.join(userProfile, '.local', 'bin'),
    path.join(userProfile, 'scoop', 'shims'),
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
  const candidates = process.platform === 'win32' ? windowsCandidates(env) : unixCandidates(env);
  return dedupe([...base, ...fallback, ...candidates]).join(path.delimiter);
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

function quoteForCmd(arg: string): string {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
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
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(' ');
    return {
      command: resolveWindowsCmdShell(expandedEnv),
      args: ['/d', '/s', '/c', commandLine],
    };
  }

  return { command: executable, args };
}