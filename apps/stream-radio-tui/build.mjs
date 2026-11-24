import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const commit = process.env.GITHUB_SHA?.slice(0, 7) || execSync('git rev-parse --short HEAD').toString().trim()

await build({
  entryPoints: ['src/main.tsx'],
  outfile: 'dist/stream-radio-tui.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  external: ['react-devtools-core'],
  define: {
    'process.env.NODE_ENV': '"production"',
    __VERSION__: JSON.stringify(pkg.version),
    __COMMIT__: JSON.stringify(commit),
  },
})
