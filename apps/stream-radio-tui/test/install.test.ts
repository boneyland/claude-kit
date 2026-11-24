import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const APP = path.resolve(__dirname, '..')
const BUNDLE = path.join(APP, 'dist/stream-radio-tui.mjs')
const INSTALL = path.join(APP, 'install.sh')

let server: http.Server
let url = ''
let tmp = ''

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

const NEEDED = ['sh', 'node', 'curl', 'mkdir', 'mktemp', 'mv', 'chmod', 'rm']

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-test-'))
  if (!fs.existsSync(BUNDLE)) {
    await new Promise<void>((resolve, reject) =>
      execFile('node', ['build.mjs'], { cwd: APP }, err => (err ? reject(err) : resolve())),
    )
  }
  server = http.createServer((req, res) => {
    if (req.url === '/stream-radio-tui.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(fs.readFileSync(BUNDLE))
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
    expect(v).toMatch(/^stream-radio-tui 0\.1\.0 /)
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

  it('leaves nothing behind when the download fails', async () => {
    const prefix = path.join(tmp, 'fail-bin')
    const bin = pathWith('fail-path', NEEDED, ['mpv'])
    const r = await run({ PATH: bin, HOME: tmp, PREFIX: prefix, STREAM_RADIO_TUI_URL: url + '.missing' })
    expect(r.code).not.toBe(0)
    expect(fs.existsSync(prefix) ? fs.readdirSync(prefix) : []).toEqual([])
  })
})
