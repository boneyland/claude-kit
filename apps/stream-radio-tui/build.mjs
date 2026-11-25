import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { INK_OUTPUT, patchInkOutput } from './ink-width-fix.mjs'

// The version: the commit's date (UTC), then its short hash, as
// 2026.11.26+e23f472; the same commit builds the same version. 'unknown'
// outside a git checkout (a source tarball). The workflow's Publish step
// names the release with the same git command.
const version = () => {
  try {
    return execSync('git show -s --abbrev=7 --date=format-local:%Y.%m.%d --format=%cd+%h HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TZ: 'UTC' },
    })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

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

// See ink-width-fix.mjs.
const inkWidth = {
  name: 'ink-width-fix',
  setup(b) {
    b.onLoad({ filter: INK_OUTPUT }, async args => ({ contents: patchInkOutput(await readFile(args.path, 'utf8')), loader: 'js' }))
  },
}

await build({
  entryPoints: ['src/main.tsx'],
  // STREAM_RADIO_TUI_OUT: build somewhere else (the installer test), dist/ by default
  outfile: process.env.STREAM_RADIO_TUI_OUT || 'dist/stream-radio-tui.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  plugins: [noDevtools, inkWidth],
  define: {
    'process.env.NODE_ENV': '"production"',
    __VERSION__: JSON.stringify(version()),
  },
})
