import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { INK_OUTPUT, patchInkOutput } from './ink-width-fix.mjs'

// Ink and its testing library, which the tests load through vite (below).
const INK = /[\\/]node_modules[\\/]ink(-testing-library)?[\\/]/
// Their sourcemaps name sources the packages don't ship. Loading the files
// here, without that comment, keeps vite from looking for them and warning.
const dropSourcemapUrl = (code: string) => code.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n')

// Few workers and a per-test timeout: this machine freezes under memory pressure.
export default defineConfig({
  // as tsconfig.json's paths: the mod's core
  resolve: { alias: { '@core': fileURLToPath(new URL('../../plugins/stream-radio/core', import.meta.url)) } },
  // See ink-width-fix.mjs: the tests draw with the same Ink the build ships.
  plugins: [
    {
      name: 'ink-width-fix',
      enforce: 'pre',
      load: id => {
        if (!INK.test(id)) return undefined
        const code = readFileSync(id.split('?')[0], 'utf8')
        return { code: dropSourcemapUrl(INK_OUTPUT.test(id) ? patchInkOutput(code) : code), map: null }
      },
    },
  ],
  test: {
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 10_000,
    include: ['test/**/*.test.{ts,tsx}'],
    // Ink must go through the plugin above, not load straight from node_modules.
    server: { deps: { inline: [INK] } },
  },
})
