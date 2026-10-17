import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'where.exe' : 'which';
const lookup = spawnSync(command, ['tsc'], { stdio: 'ignore', shell: false });
if (lookup.status === 0) {
  const result = spawnSync('tsc', ['--noEmit'], { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(result.status ?? 1);
}

for (const file of ['src/archive.ts', 'src/index.ts', 'test/archive.test.ts']) {
  const syntax = spawnSync(process.execPath, ['--experimental-strip-types', '--check', file], { stdio: 'inherit' });
  if (syntax.status !== 0) process.exit(syntax.status ?? 1);
}
console.warn('tsc is unavailable; native TypeScript syntax checks passed.');
