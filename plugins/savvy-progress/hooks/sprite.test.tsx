import { expect, mock, test } from 'claude-code/testing'

import { crabKey, crabSprite, crabTick } from './register'
import { SPRITE_COLS, SPRITE_ROWS, spritePixels } from './sprite'

const PLUGIN = 'savvy-progress'
const pane = { title: '', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const fromBase64 = (s: string) => (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(s)

test('a sprite frame is a PNG, and each costume moves between frames', () => {
  const png = fromBase64(crabSprite('medium', 0))
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  // Pixel art packs small: a frame stays a couple of kilobytes.
  expect(png.length).toBeLessThan(2048)
  for (const costume of ['fable', 'heavy', 'careful', 'medium', 'light', 'explore', 'other']) {
    const frames = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(f => crabSprite(costume, f)))
    expect(frames.size).toBeGreaterThan(1)
  }
  // The body is clay where the crab stands.
  const px = spritePixels('other', f => f(7, 10, 16, 12, '#D97757'), null)
  const at = (x: number, y: number) => [...px.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)]
  expect(at(10, 15)).toEqual([0xd9, 0x77, 0x57, 255])
  expect(at(0, 0)[3]).toBe(0)
})

test('in kitty the panel draws pixel crabs, blits their frames, and falls back to cells when the terminal turns them away', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'KITTY_WINDOW_ID' ? '1' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'savvy-agents' }] }) as never)
  on('agent.list', () => ({ value: [] as never }))
  let refuse = false
  const blits: { key: string; source?: { png: string } }[] = []
  on('ui.blit', (_, e) => {
    blits.push(e as never)
    return { value: refuse ? { deny: 'the Image draws its alt there' } : {} }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'agents-info', args: 'demo' } as never)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const image = await ui.find({ type: 'Image', key: crabKey('demo-1') })
  expect(image?.props.columns).toBe(SPRITE_COLS)
  expect(image?.props.rows).toBe(SPRITE_ROWS)
  expect(image?.props.source).toEqual({ png: crabSprite('fable', crabTick(1_000_000, 'demo-1')) })
  // A finished agent's crab stands still.
  expect((await ui.find({ type: 'Image', key: crabKey('demo-4') }))?.props.source).toEqual({ png: crabSprite('heavy', null) })
  expect(await ui.find({ type: 'Raster' })).toBe(undefined)
  await ui.unmount()

  await clock.advance(125)
  const sprites = blits.filter(b => b.source)
  // The three running demo agents.
  expect(sprites.map(b => b.key).sort()).toEqual(['crab-demo-1', 'crab-demo-2', 'crab-demo-3'])

  refuse = true
  await clock.advance(125)
  const after = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane })
  expect(await after.find({ type: 'Image' })).toBe(undefined)
  expect(await after.find({ type: 'Raster', key: crabKey('demo-1') })).toBeTruthy()
  await after.unmount()
})
