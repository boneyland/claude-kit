import { describe, expect, test } from 'vitest'
import { deleteImage, placeVirtual } from '../src/gfx/kitty'
import { kittyGraphics, leaveScreen } from '../src/gfx/screen'
import type { Art } from '../src/media/art'

const strip = (): Art => ({ width: 2, height: 1, rgba: new Uint8Array(8) })
const capture = () => {
  const out: string[] = []
  return { out, write: (s: string) => void out.push(s), text: () => out.join('') }
}
const count = (text: string, part: string) => text.split(part).length - 1

describe('kittyGraphics', () => {
  test('each strip is sent and placed as one row', () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    g.show(1, [strip(), strip(), strip()], 20)
    for (const id of [1, 2, 3]) expect(c.text()).toContain(placeVirtual(id, 20, 1))
    expect(count(c.text(), 'a=t,')).toBe(3)
  })
  test('fewer strips than last time deletes the rows no longer used', () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    g.show(1, [strip(), strip(), strip()], 20)
    c.out.length = 0
    g.show(1, [strip(), strip()], 20)
    expect(c.text()).toContain(deleteImage(3))
    expect(c.text()).not.toContain(deleteImage(1))
  })
  test('dropAll deletes every live image once', () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    g.show(1, [strip(), strip()], 20)
    g.show(201, [strip()], 20)
    g.drop(201, 1)
    c.out.length = 0
    g.dropAll()
    expect(c.text()).toBe(deleteImage(1) + deleteImage(2))
    c.out.length = 0
    g.dropAll()
    expect(c.text()).toBe('')
  })
})

describe('leaveScreen', () => {
  test('the pictures go before the alternate screen does', () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    g.show(1, [strip()], 20)
    c.out.length = 0
    leaveScreen(g, c.write)
    expect(c.text()).toBe(deleteImage(1) + '\x1b[?1049l')
  })
  test('without pictures it only leaves', () => {
    const c = capture()
    leaveScreen(undefined, c.write)
    expect(c.text()).toBe('\x1b[?1049l')
  })
})
