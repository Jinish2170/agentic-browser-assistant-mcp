import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(path);
    else if (/\.m?js$/.test(path)) {
      const r = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (r.status) process.exit(r.status);
    }
  }
}
for (const dir of ['shared', 'server', 'extension', 'scripts', 'tests']) await walk(dir);
console.log('JavaScript syntax checks passed');
