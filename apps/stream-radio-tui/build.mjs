import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const commit = process.env.GITHUB_SHA?.slice(0, 7) || execSync('git rev-parse --short HEAD').toString().trim()

// Ink imports react-devtools-core only under DEV=true, from a module it loads
// with a dynamic import; bundled into one file that import becomes a top-level
// one, so a stub stands in for the package (not installed, not wanted).
const noDevtools = {
  name: 'no-react-devtools',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { connectToDevTools() {} }', loader: 'js' }))
  },
}

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
  plugins: [noDevtools],
  define: {
    'process.env.NODE_ENV': '"production"',
    __VERSION__: JSON.stringify(pkg.version),
    __COMMIT__: JSON.stringify(commit),
  },
})
