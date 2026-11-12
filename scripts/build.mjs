import { build } from 'esbuild';
import { mkdir, cp, unlink } from 'node:fs/promises';
await mkdir('dist/extension', { recursive: true });
// Remove obsolete generated modules from the pre-bundle development build.
for (const obsolete of ['background.mjs', 'browser.mjs', 'dom.mjs']) {
  await unlink(`dist/extension/${obsolete}`).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
for (const asset of [
  'manifest.json',
  'panel.html',
  'panel.css',
  'fonts.css',
  'panel.mjs',
  'workspace.mjs',
]) {
  await cp(`extension/${asset}`, `dist/extension/${asset}`);
}
await cp('extension/fonts', 'dist/extension/fonts', { recursive: true });
await cp('extension/icons', 'dist/extension/icons', { recursive: true });
await build({
  entryPoints: ['extension/background.mjs'],
  outfile: 'dist/extension/background.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome125',
});
console.log('Extension built in dist/extension');
