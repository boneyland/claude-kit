import { describe, expect, test, vi } from 'vitest'
import React, { useRef, useEffect } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { render } from 'ink-testing-library'
import { Clickable, MouseProvider, rectOf } from '../src/mouse/Clickable'
import type { MouseEvent, MouseSource } from '../src/mouse/sgr'

const fakeSource = () => {
  let fn: ((e: MouseEvent) => void) | undefined
  const source: MouseSource = f => ((fn = f), () => (fn = undefined))
  const press = (x: number, y: number) => fn!({ kind: 'press', button: 'left', x, y })
  return { source, press, send: (e: MouseEvent) => fn!(e) }
}
const tick = () => new Promise(r => setTimeout(r, 20))

describe('Clickable', () => {
  test('a press goes to the box under it, at its own x and y; the gap between gets none', async () => {
    const s = fakeSource()
    const [a, b] = [vi.fn(), vi.fn()]
    render(
      <MouseProvider source={s.source}>
        <Text>title</Text>
        <Box>
          <Clickable onClick={a} width={4}>
            <Text>aaaa</Text>
          </Clickable>
          <Box width={2} />
          <Clickable onClick={b} width={4}>
            <Text>bbbb</Text>
          </Clickable>
        </Box>
      </MouseProvider>,
    )
    await tick()
    s.press(1, 1)
    expect(a).toHaveBeenCalledWith({ x: 1, y: 0, isDouble: false, mods: { shift: false, alt: false, ctrl: false } })
    s.press(7, 1)
    expect(b).toHaveBeenCalledWith({ x: 1, y: 0, isDouble: false, mods: { shift: false, alt: false, ctrl: false } })
    s.press(4, 1)
    s.press(1, 0)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  test('nested: the inner box gets the press, not the outer', async () => {
    const s = fakeSource()
    const [outer, inner] = [vi.fn(), vi.fn()]
    render(
      <MouseProvider source={s.source}>
        <Clickable onClick={outer} flexDirection="column">
          <Text>outer</Text>
          <Clickable onClick={inner}>
            <Text>inner</Text>
          </Clickable>
        </Clickable>
      </MouseProvider>,
    )
    await tick()
    s.press(0, 1)
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
    s.press(0, 0)
    expect(outer).toHaveBeenCalledTimes(1)
  })

  test('two presses on one box within 400 ms make a double; slower, or on another box, do not', async () => {
    const s = fakeSource()
    let now = 1000
    const [a, b] = [vi.fn(), vi.fn()]
    render(
      <MouseProvider source={s.source} now={() => now}>
        <Clickable onClick={a}>
          <Text>a</Text>
        </Clickable>
        <Clickable onClick={b}>
          <Text>b</Text>
        </Clickable>
      </MouseProvider>,
    )
    await tick()
    s.press(0, 0)
    now += 100
    s.press(0, 0)
    expect(a.mock.calls.map(c => c[0].isDouble)).toEqual([false, true])
    now += 500
    s.press(0, 0)
    now += 500
    s.press(0, 0)
    expect(a.mock.calls.map(c => c[0].isDouble)).toEqual([false, true, false, false])
    now += 100
    s.press(0, 1)
    expect(b.mock.calls[0][0].isDouble).toBe(false)
  })

  test('releases, other buttons and motion call nothing; the wheel goes to the nearest box that takes it', async () => {
    const s = fakeSource()
    const [click, wheel] = [vi.fn(), vi.fn()]
    render(
      <MouseProvider source={s.source}>
        <Clickable onWheel={wheel}>
          <Clickable onClick={click}>
            <Text>row</Text>
          </Clickable>
        </Clickable>
      </MouseProvider>,
    )
    await tick()
    s.send({ kind: 'release', button: 'left', x: 0, y: 0 })
    s.send({ kind: 'press', button: 'right', x: 0, y: 0 })
    expect(click).not.toHaveBeenCalled()
    s.send({ kind: 'wheel', button: 'none', dir: 'down', x: 1, y: 0 })
    expect(wheel).toHaveBeenCalledWith('down')
  })

  test('Ctrl on a press reaches the hit', async () => {
    const s = fakeSource()
    const a = vi.fn()
    render(
      <MouseProvider source={s.source}>
        <Clickable onClick={a}>
          <Text>a</Text>
        </Clickable>
      </MouseProvider>,
    )
    await tick()
    s.send({ kind: 'press', button: 'left', x: 0, y: 0, mods: { shift: false, alt: false, ctrl: true } })
    expect(a.mock.calls[0][0].mods).toEqual({ shift: false, alt: false, ctrl: true })
  })

  test('a drag and its release go to the box pressed, wherever they land', async () => {
    const s = fakeSource()
    const a = { onClick: vi.fn(), onDrag: vi.fn(), onRelease: vi.fn() }
    const b = { onClick: vi.fn(), onDrag: vi.fn(), onRelease: vi.fn() }
    render(
      <MouseProvider source={s.source}>
        <Text>title</Text>
        <Clickable {...a}>
          <Text>aaaa</Text>
        </Clickable>
        <Clickable {...b}>
          <Text>bbbb</Text>
        </Clickable>
      </MouseProvider>,
    )
    await tick()
    s.press(1, 1)
    s.send({ kind: 'drag', button: 'left', x: 2, y: 2 })
    s.send({ kind: 'release', button: 'left', x: 3, y: 2 })
    expect(a.onDrag).toHaveBeenCalledWith({ x: 2, y: 1 })
    expect(a.onRelease).toHaveBeenCalledWith({ x: 3, y: 1 })
    expect(b.onClick).not.toHaveBeenCalled()
    expect(b.onDrag).not.toHaveBeenCalled()
    expect(b.onRelease).not.toHaveBeenCalled()
    // after the release, a drag reaches no one
    s.send({ kind: 'drag', button: 'left', x: 2, y: 2 })
    expect(a.onDrag).toHaveBeenCalledTimes(1)
  })

  test("rectOf reads Ink's layout: a box's place on screen", async () => {
    let rect: ReturnType<typeof rectOf> | undefined
    function Probe() {
      const ref = useRef<DOMElement>(null)
      useEffect(() => void (rect = rectOf(ref.current!)))
      return (
        <Box ref={ref} width={5} height={2}>
          <Text>x</Text>
        </Box>
      )
    }
    render(
      <Box flexDirection="column" paddingLeft={3}>
        <Text>one</Text>
        <Text>two</Text>
        <Probe />
      </Box>,
    )
    await tick()
    expect(rect).toEqual({ x: 3, y: 2, width: 5, height: 2 })
  })
})
