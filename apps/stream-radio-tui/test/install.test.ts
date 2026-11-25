import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const APP = path.resolve(__dirname, '..')
const version: string = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version
const INSTALL = path.join(APP, 'install.sh')

let server: http.Server
let url = ''
let tmp = ''
let bundle = ''
// what the server gives as the bundle's checksum; a test may spoil it
let checksum = ''
// requests the checksum fails before it is served (a build being published)
let sumMisses = 0
// how many times the checksum was asked for
let sumAsks = 0

function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile('sh', [INSTALL], { env, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, out: stdout + stderr })
    })
  })
}

// A PATH dir with symlinks to just the named tools.
function pathWith(name: string, tools: string[], fakes: string[] = []): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir)
  for (const t of tools) {
    const found = (process.env.PATH ?? '').split(':').map(d => path.join(d, t)).find(p => fs.existsSync(p))
    if (found) fs.symlinkSync(found, path.join(dir, t))
  }
  for (const f of fakes) {
    fs.writeFileSync(path.join(dir, f), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  return dir
}

const NEEDED = ['sh', 'node', 'curl', 'mkdir', 'mktemp', 'mv', 'chmod', 'rm', 'cut', 'sha256sum', 'sleep']
// a failure is tried again at once in tests
const NOW = { STREAM_RADIO_TUI_WAIT: '0' }

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-test-'))
  // always a fresh build, to a file of its own: never a leftover dist/
  bundle = path.join(tmp, 'stream-radio-tui.mjs')
  await new Promise<void>((resolve, reject) =>
    execFile('node', ['build.mjs'], { cwd: APP, env: { ...process.env, STREAM_RADIO_TUI_OUT: bundle } }, err => (err ? reject(err) : resolve())),
  )
  checksum = createHash('sha256').update(fs.readFileSync(bundle)).digest('hex')
  server = http.createServer((req, res) => {
    if (req.url === '/stream-radio-tui.mjs.sha256') {
      sumAsks += 1
      if (sumMisses > 0) {
        sumMisses -= 1
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`${checksum}  stream-radio-tui.mjs\n`)
    } else if (req.url === '/stream-radio-tui.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(fs.readFileSync(bundle))
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stream-radio-tui.mjs`
}, 60_000)

afterAll(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('install.sh', () => {
  it('installs an executable that runs, and says whether the folder is on PATH', async () => {
    const prefix = path.join(tmp, 'ok-bin')
    const bin = pathWith('ok-path', NEEDED, ['mpv', 'yt-dlp', 'python3'])
    const r = await run({ PATH: bin, HOME: tmp, PREFIX: prefix, STREAM_RADIO_TUI_URL: url })
    expect(r.out).toContain(prefix)
    expect(r.code).toBe(0)
    const target = path.join(prefix, 'stream-radio-tui')
    expect(() => fs.accessSync(target, fs.constants.X_OK)).not.toThrow()
    expect(fs.readdirSync(prefix)).toEqual(['stream-radio-tui'])
    const v = await new Promise<string>((resolve, reject) =>
      execFile(target, ['--version'], (err, stdout) => (err ? reject(err) : resolve(stdout))),
    )
    expect(v).toMatch(new RegExp(`^stream-radio-tui ${version.replaceAll('.', '\\.')} `))
    expect(r.out).toMatch(/not on your PATH/)
  })

  it('exits 1 naming mpv when it is missing', async () => {
    const prefix = path.join(tmp, 'nompv-bin')
    const bin = pathWith('nompv-path', NEEDED)
    const r = await run({ PATH: bin, HOME: tmp, PREFIX: prefix, STREAM_RADIO_TUI_URL: url })
    expect(r.code).toBe(1)
    expect(r.out).toContain('mpv')
    expect(fs.existsSync(path.join(prefix, 'stream-radio-tui'))).toBe(false)
  })

  it('installs nothing when the download does not match its checksum', async () => {
    const prefix = path.join(tmp, 'badsum-bin')
    const bin = pathWith('badsum-path', NEEDED, ['mpv'])
    const good = checksum
    checksum = '0'.repeat(64)
    try {
      const r = await run({ PATH: bin, HOME: tmp, PREFIX: prefix, STREAM_RADIO_TUI_URL: url, ...NOW })
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('the download does not match its checksum; nothing was installed.')
      expect(r.out).toContain('(3 of 3)')
      expect(fs.existsSync(prefix) ? fs.readdirSync(prefix) : []).toEqual([])
    } finally {
      checksum = good
    }
  })

  it('leaves nothing behind when the download fails', async () => {
    const prefix = path.join(tmp, 'fail-bin')
    const bin = pathWith('fail-path', NEEDED, ['mpv'])
    const r = await run({ PATH: bin, HOME: tmp, PREFIX: prefix, STREAM_RADIO_TUI_URL: url + '.missing', ...NOW })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`could not download ${url}.missing; nothing was installed.`)
    expect(fs.existsSync(prefix) ? fs.readdirSync(prefix) : []).toEqual([])
  })

  it('says the checksum could not be downloaded, not that it does not match', async () => {
    const prefix = path.join(tmp, 'nosum-bin')
    const bin = pathWith('nosum-path', NEEDED, ['mpv'])
    sumMisses = 99
    try {
      const r = await run({ PATH: bin, HOME: tmp, PREFIX: prefix, STREAM_RADIO_TUI_URL: url, ...NOW })
      expect(r.code).not.toBe(0)
      expect(r.out).toContain(`could not download its checksum, ${url}.sha256; nothing was installed.`)
      expect(r.out).not.toContain('does not match')
      expect(fs.existsSync(prefix) ? fs.readdirSync(prefix) : []).toEqual([])
    } finally {
      sumMisses = 0
    }
  })

  it('tries again when the checksum is missing for a moment, as while a build is published', async () => {
    const prefix = path.join(tmp, 'retry-bin')
    const bin = pathWith('retry-path', NEEDED, ['mpv'])
    sumMisses = 1
    sumAsks = 0
    const r = await run({ PATH: bin, HOME: tmp, PREFIX: prefix, STREAM_RADIO_TUI_URL: url, ...NOW })
    expect(r.code).toBe(0)
    expect(sumAsks).toBe(2)
    expect(r.out).toContain('Trying again in 0 s (2 of 3)')
    expect(fs.readdirSync(prefix)).toEqual(['stream-radio-tui'])
  })
})
