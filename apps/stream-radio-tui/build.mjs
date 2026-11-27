import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { appendFile, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { INK_DOM, INK_OUTPUT, patchInk } from './ink-width-fix.mjs'

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
    for (const filter of [INK_OUTPUT, INK_DOM]) {
      b.onLoad({ filter }, async args => ({ contents: patchInk(args.path, await readFile(args.path, 'utf8')), loader: 'js' }))
    }
  },
}

// A package that ships no licence file but names MIT (yoga-layout,
// @alcalzone/ansi-tokenize): the MIT licence, its author from package.json.
// Any other gap stops the build, to be looked at.
const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`
function mitText(pkg) {
  const author = typeof pkg.author === 'string' ? pkg.author.replace(/\s*[<(].*$/, '') : pkg.author?.name
  if (pkg.license !== 'MIT' || !author) throw new Error(`build: ${pkg.name} ships no licence file, and its package.json names no MIT author; add its licence by hand`)
  return `MIT License (the package ships no licence file; this is the licence its package.json names)\n\nCopyright (c) ${author}\n\n${MIT}`
}

// The licences of the packages bundled in, at the end of the bundle: MIT and
// the like ask that their notice go with every copy, and the release is this
// one file. A package is the folder after the last node_modules/ in a bundled
// file's path (two parts for a scope).
async function licenceNotice(inputs) {
  const dirs = new Set()
  for (const file of Object.keys(inputs)) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file.replaceAll('\\', '/'))
    if (m) dirs.add(m[1])
  }
  const parts = []
  for (const dir of [...dirs].sort()) {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
    const file = (await readdir(dir)).find(f => /^licen[cs]e/i.test(f))
    const text = file ? (await readFile(path.join(dir, file), 'utf8')).trim() : mitText(pkg)
    parts.push(`${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})\n\n${text}`)
  }
  const unique = [...new Set(parts)].sort((a, b) => a.localeCompare(b))
  // a */ in a licence would end the comment early
  return `\n/*! Third-party licences: the packages bundled into this file.\n\n${unique.join('\n\n' + '-'.repeat(72) + '\n\n').replaceAll('*/', '* /')}\n*/\n`
}

const outfile = process.env.STREAM_RADIO_TUI_OUT || 'dist/stream-radio-tui.mjs'
const result = await build({
  entryPoints: ['src/main.tsx'],
  // STREAM_RADIO_TUI_OUT: build somewhere else (the installer test), dist/ by default
  outfile,
  metafile: true,
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

await appendFile(outfile, await licenceNotice(result.metafile.inputs))
