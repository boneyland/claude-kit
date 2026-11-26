import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { FILES_KEY_HELP, KEY_HELP, PLAYLISTS_KEY_HELP, QUEUE_KEY_HELP, USAGE } from '../src/help'

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')

// The keys in a help label: single characters, named keys and chords; not
// the words around them ("twice", "click heading").
const KEY = /^(?:[^\sA-Za-z]|[A-Za-z]|Tab|Esc|Enter|Delete|space|PgUp|PgDn|Home|End|(?:Ctrl|Shift|Alt)-\S+)$/
const keysOf = (label: string) => label.split(/[\s,]+/).filter(t => KEY.test(t))

describe('the key lists', () => {
  test('the README names every key the ? screen and --help list', () => {
    const missing = [...KEY_HELP, ...QUEUE_KEY_HELP, ...FILES_KEY_HELP, ...PLAYLISTS_KEY_HELP].flatMap(([label]) => keysOf(label).filter(k => !README.includes(`\`${k}\``)).map(k => `${k} (from "${label}")`))
    expect(missing).toEqual([])
  })

  test('the README has a Playlists table naming every key of the tab', () => {
    const at = README.indexOf('### Playlists')
    expect(at).toBeGreaterThan(0)
    const end = README.indexOf('\n## ', at)
    const section = README.slice(at, end < 0 ? undefined : end)
    const missing = PLAYLISTS_KEY_HELP.flatMap(([label]) => keysOf(label).filter(k => !section.includes(`\`${k}\``)))
    expect(missing).toEqual([])
  })

  test('stop keeps the playlist, and S ends at as queued', () => {
    expect(KEY_HELP).toContainEqual(['x', 'stop (the queue stays)'])
    expect(KEY_HELP.find(([k]) => k === 'S')![1]).toContain('as queued')
    expect(USAGE).toContain('stop (the queue stays)')
    expect(README).toContain('as queued')
  })

  test('--help lists every key', () => {
    for (const [label, what] of [...KEY_HELP, ...QUEUE_KEY_HELP, ...FILES_KEY_HELP, ...PLAYLISTS_KEY_HELP]) {
      expect(USAGE).toContain(`  ${label} `)
      expect(USAGE).toContain(what)
    }
  })
})
