import { defineConfig } from 'vitest/config'

// Few workers and a per-test timeout: this machine freezes under memory pressure.
export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 10_000,
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
