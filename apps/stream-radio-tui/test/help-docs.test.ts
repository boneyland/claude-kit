import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { FILES_KEY_HELP, KEY_HELP, PLAYLIST_KEY_HELP, USAGE } from '../src/help'

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')

// The keys in a help label: single characters, named keys and chords; not
// the words around them ("twice", "click heading").
const KEY = /^(?:[^\sA-Za-z]|[A-Za-z]|Tab|Esc|Enter|Delete|space|(?:Ctrl|Shift|Alt)-\S+)$/
const keysOf = (label: string) => label.split(/[\s,]+/).filter(t => KEY.test(t))

describe('the key lists', () => {
  test('the README names every key the ? screen and --help list', () => {
    const missing = [...KEY_HELP, ...PLAYLIST_KEY_HELP, ...FILES_KEY_HELP].flatMap(([label]) => keysOf(label).filter(k => !README.includes(`\`${k}\``)).map(k => `${k} (from "${label}")`))
    expect(missing).toEqual([])
  })

  test('--help lists every key', () => {
    for (const [label, what] of [...KEY_HELP, ...PLAYLIST_KEY_HELP, ...FILES_KEY_HELP]) {
      expect(USAGE).toContain(`  ${label} `)
      expect(USAGE).toContain(what)
    }
  })
})
