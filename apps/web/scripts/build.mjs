import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const onlyTypecheck = process.argv.includes('--typecheck');
const require = createRequire(import.meta.url);
const heap = '--max-old-space-size=4096';

// §PERF-BOOT — hard budget for the ENTRY chunk (gzip). The entry is what every
// user downloads before ANYTHING paints; it was measured at 188 KB gz and cut
// to 137.6 KB by moving hidden-modal/barrel code out. Vite's 500 KB raw warning
// is advisory and was being ignored — this gate is not. If you hit it, the fix
// is a lazy import or a subpath import (see docs/PERFORMANCE-BOOT-10X.md §5),
// not a bigger budget.
const ENTRY_GZIP_BUDGET_KB = 150;

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function enforceEntryBudget() {
  const assets = join(process.cwd(), 'dist', 'assets');
  const entries = readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f));
  for (const file of entries) {
    const gzKb = gzipSync(readFileSync(join(assets, file)), { level: 9 }).length / 1024;
    if (gzKb > ENTRY_GZIP_BUDGET_KB) {
      console.error(
        `\n✗ entry-chunk budget: ${file} is ${gzKb.toFixed(1)} KB gzipped — budget is ${ENTRY_GZIP_BUDGET_KB} KB.\n`
        + '  Something eager grew the boot payload. Lazy-load it or use a subpath import.\n',
      );
      process.exit(1);
    }
    console.log(`✓ entry-chunk budget: ${file} ${gzKb.toFixed(1)} KB gz (budget ${ENTRY_GZIP_BUDGET_KB} KB)`);
  }
}

run(process.execPath, [heap, require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit']);
if (!onlyTypecheck) {
  const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  run(process.execPath, [heap, viteBin, 'build']);
  enforceEntryBudget();
}
