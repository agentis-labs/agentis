import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const onlyTypecheck = process.argv.includes('--typecheck');
const require = createRequire(import.meta.url);
const heap = '--max-old-space-size=4096';

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

run(process.execPath, [heap, require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit']);
if (!onlyTypecheck) {
  const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  run(process.execPath, [heap, viteBin, 'build']);
}
