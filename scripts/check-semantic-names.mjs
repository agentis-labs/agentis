import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const roots = ['apps', 'packages'];
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const ignored = new Set(['node_modules', 'dist', 'coverage', '.turbo']);
const forbidden = [
  /\b(?:AppBlueprint|ComponentManifest|RuntimeProfile|ListenerConfig)V\d+\b/g,
  /\bisV\d+[A-Z][A-Za-z0-9]*\b/g,
  /\b(?:App Blueprint|Component|Listener Runtime|Runtime Profile)\s+V\d+\b/gi,
];

function files(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (extensions.has(extname(path))) out.push(path);
  }
  return out;
}

const violations = [];
for (const sourceRoot of roots) {
  for (const path of files(join(root, sourceRoot))) {
    const content = readFileSync(path, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of forbidden) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (match) violations.push(`${relative(root, path)}:${index + 1}: ${match[0]}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error('Agentis-owned ordinal feature names are forbidden. Use a stable semantic name plus revision metadata.');
  violations.forEach((violation) => console.error(`  ${violation}`));
  process.exit(1);
}

console.log('Semantic feature-name check passed.');
