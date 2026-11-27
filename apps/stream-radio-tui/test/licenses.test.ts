import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'

const APP = fileURLToPath(new URL('..', import.meta.url))
let tmp = ''
let bundle = ''

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'licenses-test-'))
  const out = path.join(tmp, 'stream-radio-tui.mjs')
  await new Promise<void>((resolve, reject) =>
    execFile('node', ['build.mjs'], { cwd: APP, env: { ...process.env, STREAM_RADIO_TUI_OUT: out } }, err => (err ? reject(err) : resolve())),
  )
  bundle = fs.readFileSync(out, 'utf8')
}, 60_000)

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// The notice at the end of the bundle: each package's name, version and licence text.
const notice = () => bundle.slice(bundle.lastIndexOf('/*! Third-party licences'))

test('the bundle ends with the licences of the packages bundled into it', () => {
  expect(bundle.includes('/*! Third-party licences')).toBe(true)
  for (const name of ['ink', 'react', 'yoga-layout', 'music-metadata']) {
    expect(notice()).toMatch(new RegExp(`^${name}@\\d`, 'm'))
  }
  expect(notice()).toContain('Permission is hereby granted')
})

test('every package bundled has its licence text, and the notice closes once', () => {
  // one block per package, each with a copyright or licence text after its name line
  const blocks = notice().split(/\n-{72}\n/)
  expect(blocks.length).toBeGreaterThan(20)
  for (const b of blocks) expect(b).toMatch(/copyright|permission|licen[cs]e/i)
  expect(notice().trimEnd().endsWith('*/')).toBe(true)
  expect(notice().slice(0, -2)).not.toContain('*/')
})
