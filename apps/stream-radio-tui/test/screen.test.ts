import { describe, expect, test } from 'vitest'
import { deleteImage, placeVirtual } from '../src/gfx/kitty'
import { kittyGraphics, leaveScreen } from '../src/gfx/screen'
import { MOUSE_OFF } from '../src/mouse/sgr'
import type { Art } from '../src/media/art'

const strip = (): Art => ({ width: 2, height: 1, rgba: new Uint8Array(8) })
const capture = () => {
  const out: string[] = []
  return { out, write: (s: string) => void out.push(s), text: () => out.join('') }
}
const count = (text: string, part: string) => text.split(part).length - 1

describe('kittyGraphics', () => {
  test('each strip is sent and placed as one row', async () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    await g.show(1, [strip(), strip(), strip()], 20)
    for (const id of [1, 2, 3]) expect(c.text()).toContain(placeVirtual(id, 20, 1))
    expect(count(c.text(), 'a=t,')).toBe(3)
  })
  test('fewer strips than last time deletes the rows no longer used', async () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    await g.show(1, [strip(), strip(), strip()], 20)
    c.out.length = 0
    await g.show(1, [strip(), strip()], 20)
    expect(c.text()).toContain(deleteImage(3))
    expect(c.text()).not.toContain(deleteImage(1))
  })
  test('dropAll deletes every live image once', async () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    await g.show(1, [strip(), strip()], 20)
    await g.show(201, [strip()], 20)
    g.drop(201, 1)
    c.out.length = 0
    g.dropAll()
    expect(c.text()).toBe(deleteImage(1) + deleteImage(2))
    c.out.length = 0
    g.dropAll()
    expect(c.text()).toBe('')
  })
  test('a show overtaken while it compresses is never written', async () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    const first = g.show(1, [strip(), strip(), strip()], 20)
    const second = g.show(1, [strip()], 10)
    await Promise.all([first, second])
    expect(count(c.text(), 'a=t,')).toBe(1)
    expect(c.text()).toContain(placeVirtual(1, 10, 1))
    expect(c.text()).not.toContain(placeVirtual(1, 20, 1))
  })
  test('a drop, or leaving, while a show compresses leaves nothing behind', async () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    const dropped = g.show(1, [strip()], 20)
    g.drop(1, 0)
    const left = g.show(201, [strip()], 20)
    g.dropAll()
    await Promise.all([dropped, left])
    expect(c.text()).not.toContain('a=t,')
  })
})

describe('leaveScreen', () => {
  test('the pictures go before the alternate screen does', async () => {
    const c = capture()
    const g = kittyGraphics(c.write, { width: 8, height: 16 })
    await g.show(1, [strip()], 20)
    c.out.length = 0
    leaveScreen(g, c.write)
    expect(c.text()).toBe(deleteImage(1) + MOUSE_OFF + '\x1b[?1049l')
  })
  test('without pictures it turns the mouse off and leaves', () => {
    const c = capture()
    leaveScreen(undefined, c.write)
    expect(c.text()).toBe(MOUSE_OFF + '\x1b[?1049l')
  })
})
