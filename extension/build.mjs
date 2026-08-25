// Bundles the extension with esbuild (provided by vite's dependency tree).
// Output goes to extension/dist/, which is the folder loaded as an unpacked
// extension. Run from the repo root: node extension/build.mjs
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outDir = join(root, 'dist')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [
    join(root, 'src/background.ts'),
    join(root, 'src/bridge.ts'),
    join(root, 'src/content.ts'),
    join(root, 'src/workbench.ts'),
  ],
  bundle: false,
  format: 'esm',
  target: 'chrome111',
  outdir: outDir,
})

cpSync(join(root, 'manifest.json'), join(outDir, 'manifest.json'))
cpSync(join(root, 'workbench.html'), join(outDir, 'workbench.html'))
cpSync(join(root, 'workbench.css'), join(outDir, 'workbench.css'))

console.log('extension bundled to', outDir)
