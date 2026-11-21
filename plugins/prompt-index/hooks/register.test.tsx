import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { inView, matches, ownersOf, promptLine, promptsOf, sectionsOn, showing, showsText, step } from './register'

const PANE = {
  plugin: 'prompt-index',
  component: 'Pane',
  requestId: 'prompt-index',
  props: {
    title: 'Prompts',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const ROWS: SessionMessage[] = [
  { role: 'user', text: 'fix the cache timer', toolUses: [], uuid: 'u1' },
  { role: 'assistant', text: 'Done.', toolUses: [], uuid: 'a1' },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 't', text: 'ok', isError: false }],
    uuid: 'u2',
  },
  {
    role: 'user',
    text: '<command-name>/tui</command-name>\n<command-message>tui</command-message>\n<command-args></command-args>',
    toolUses: [],
    uuid: 'u3',
  },
  { role: 'assistant', text: 'Opened the TUI skill.', toolUses: [], uuid: 'a3' },
  { role: 'user', text: '<local-command-stdout>hi</local-command-stdout>', toolUses: [], uuid: 'u4' },
  { role: 'user', text: 'add a scrollbar\nplease', toolUses: [], uuid: 'u5' },
]

test('promptLine keeps typed prompts and slash commands only', () => {
  expect(promptLine('  hello\n  there ')).toBe('hello there')
  expect(promptLine('<command-name>/plugin</command-name><command-args>x</command-args>')).toBe(
    '/plugin x',
  )
  expect(promptLine('<local-command-stdout>x</local-command-stdout>')).toBe(null)
  expect(promptLine('[Request interrupted by user]')).toBe(null)
  expect(promptLine('')).toBe(null)
})

test('a prompt with pasted text is a prompt, so its reply is not given to the command before it', () => {
  const pasted = '\n\n<pasted_content id="a1">\n  still fails\n</pasted_content id="a1">\n\n typing it worked'
  expect(promptLine(pasted)).toBe('still fails typing it worked')
  const cmd = '<command-name>/stream</command-name>\n<command-message>stream</command-message>\n<command-args></command-args>'
  const rows: SessionMessage[] = [
    { role: 'user', text: cmd, toolUses: [], uuid: 'c1' },
    { role: 'user', text: pasted, toolUses: [], uuid: 'p1' },
    { role: 'assistant', text: 'ok', toolUses: [], uuid: 'a1' },
  ]
  expect(promptsOf(rows, new Set()).map(p => p.id)).toEqual(['p1'])
})

test('a slash command is listed only when Claude answered it', () => {
  const cmd = (name: string) => `<command-name>${name}</command-name>\n<command-message>x</command-message>\n<command-args></command-args>`
  const rows: SessionMessage[] = [
    { role: 'user', text: cmd('/plugin'), toolUses: [], uuid: 'c1' },
    { role: 'user', text: '<local-command-stdout>(no content)</local-command-stdout>', toolUses: [], uuid: 'o1' },
    { role: 'user', text: cmd('/reload-plugins'), toolUses: [], uuid: 'c2' },
    { role: 'user', text: 'fix the bug', toolUses: [], uuid: 'p1' },
    { role: 'assistant', text: 'Fixed.', toolUses: [], uuid: 'a1' },
    { role: 'user', text: cmd('/superpowers:brainstorming'), toolUses: [], uuid: 'c3' },
    { role: 'assistant', text: 'Using brainstorming.', toolUses: [], uuid: 'a2' },
    { role: 'user', text: 'typed, not answered yet', toolUses: [], uuid: 'p2' },
    { role: 'user', text: cmd('/my-skill'), toolUses: [], uuid: 'c4' },
  ]
  expect(promptsOf(rows, new Set()).map(p => p.id)).toEqual(['p1', 'c3', 'p2'])
  // While a turn runs, the last command's reply is on its way.
  expect(promptsOf(rows, new Set(), true).map(p => p.id)).toEqual(['p1', 'c3', 'p2', 'c4'])
})

test('step wraps round and starts from the cursor or the screen', () => {
  const list = [
    { id: 'a', text: 'cache one' },
    { id: 'b', text: 'other' },
    { id: 'c', text: 'cache two' },
  ]
  const hits = matches(list, 'CACHE')
  expect(hits.map(h => h.id)).toEqual(['a', 'c'])
  expect(step(list, hits, 'a', new Set(), 1)?.id).toBe('c')
  expect(step(list, hits, 'c', new Set(), 1)?.id).toBe('a')
  expect(step(list, hits, 'a', new Set(), -1)?.id).toBe('c')
  expect(step(list, hits, '', new Set(['b']), 1)?.id).toBe('c')
  expect(step(list, hits, '', new Set(['b']), -1)?.id).toBe('a')
  expect(step(list, hits, '', new Set(), -1)?.id).toBe('c')
  expect(step(list, [], 'a', new Set(), 1)).toBe(undefined)
})

test('the pane lists prompts, filters them and jumps on a press', async ($, on) => {
  on('command.register', () => ({ value: { command: 'prompts' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: ROWS }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /fix the cache timer/ }))?.text).toContain('fix')
    expect(await ui.find({ type: 'Text', text: /^\/tui$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /add a scrollbar please/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Done\./ })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /hi/ })).toBe(undefined)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'filter', text: 'scroll', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /fix the cache timer/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /match/ }))?.text).toBe('1 of 3 match')
  // The test kit can't scroll a transcript; the press still marks the prompt.
  await ui.press({ key: 'u5' })
  expect((await ui.find({ type: 'Text', text: /add a scrollbar/ }))?.props.bold).toBe(true)
  await ui.unmount()

  // Prev and Next hold the press until the jump lands, filtered or not.
  const all = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await all.input({ key: 'filter', text: '', kind: 'change' })
  await all.press({ key: 'prev' })
  expect((await all.find({ type: 'Text', text: /^\/tui$/ }))?.props.bold).toBe(true)
  await all.press({ key: 'prev' })
  expect((await all.find({ type: 'Text', text: /fix the cache timer/ }))?.props.bold).toBe(true)
  await all.press({ key: 'next' })
  expect((await all.find({ type: 'Text', text: /^\/tui$/ }))?.props.bold).toBe(true)
  await all.unmount()
})

test('the footer button opens and closes the pane', async ($, on) => {
  let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  on('command.register', () => ({ value: { command: 'prompts' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: ROWS }))
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_, e) => {
    panes = [{ id: e.id, title: 'Prompts', isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    panes = []
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'prompt-index',
      component: 'SessionMode',
      surface,
      props: { modes: ['focus'] },
    })
    // The engine's own mode labels stay, drawn as its node beside the button.
    expect(JSON.stringify((await ui.find({ type: 'Box' }))?.children[0])).toContain('"engine"')
    expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('Prompts')
    await ui.press({ key: 'toggle' })
    expect(panes.map(p => p.id)).toEqual(['prompt-index'])
    expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('Hide prompts')
    await ui.press({ key: 'toggle' })
    expect(panes).toEqual([])
    expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('Prompts')
    await ui.unmount()
  }
})

test('a prompt is on screen only while a row of its text is', () => {
  expect(showsText(null)).toBe(false)
  expect(showsText(undefined)).toBe(false)
  // Only the blank row above it, at the viewport's bottom edge.
  expect(showsText({ first: 0, last: 0 })).toBe(false)
  expect(showsText({ first: 0, last: 1 })).toBe(true)
  // Its top scrolled away, its last row still showing.
  expect(showsText({ first: 3, last: 3 })).toBe(true)
  expect(showing([], 7)).toBe('7 prompts')
  expect(showing([5], 7)).toBe('showing 5 of 7')
  expect(showing([4, 5, 6, 7], 7)).toBe('showing 4-7 of 7')
})

test('a row on screen counts for the prompt whose section it is in', () => {
  const rows: SessionMessage[] = [
    ...ROWS,
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'ls' } }],
      uuid: 'a2',
    },
  ]
  const list = promptsOf(rows, new Set())
  expect(list.map(p => p.id)).toEqual(['u1', 'u3', 'u5'])
  const { map, order } = ownersOf(rows, list)
  expect(order).toEqual(['u1', 'collapsed-u1', 'a1', 'collapsed-a1', 'u2', 'collapsed-u2', 'u3', 'collapsed-u3', 'a3', 'collapsed-a3', 'u4', 'collapsed-u4', 'u5', 'collapsed-u5', 'a2', 'collapsed-a2', 'toolu_1'])
  expect(map.get('a1')).toBe('u1')
  expect(map.get('toolu_1')).toBe('u5')
  expect(map.get('collapsed-a2')).toBe('u5')
  // Reading u1's reply, its prompt row scrolled away: u1 is the section shown.
  expect(sectionsOn(list, map, new Set(['a1'])).map(p => p.id)).toEqual(['u1'])
  // From u1's reply down to u5's tool call.
  const across = sectionsOn(list, map, new Set(['a1', 'u3', 'u5', 'toolu_1']))
  expect(showing(across.map(p => list.indexOf(p) + 1), list.length)).toBe('showing 1-3 of 3')
  // Only rows drawn since the last read: the turn running now, the latest prompt.
  expect(sectionsOn(list, map, new Set(['toolu_new'])).map(p => p.id)).toEqual(['u5'])
  expect(sectionsOn(list, map, new Set()).map(p => p.id)).toEqual([])
})

test('rows left behind by a jump are not on screen', () => {
  const ids = ['p4', 'a4', 'p5', 't5', 'p6', 'a6', 'p7', 'a7']
  type Report = { at: { first: number; last: number; of: number } | null; n: number }
  const r = (first: number, last: number, of: number, n: number): Report => ({ at: { first, last, of }, n })
  const reports = new Map<string, Report>([
    // Left on screen when the person jumped up: they never said they left.
    ['p7', r(0, 1, 2, 1)],
    ['a7', r(0, 9, 10, 2)],
    // Passed the edge on the way, so it said so.
    ['a6', { at: null, n: 3 }],
    // Where the jump landed: p4's tail at the top, t5 cut by the bottom.
    ['a4', r(3, 5, 6, 4)],
    ['p5', r(0, 1, 2, 5)],
    ['t5', r(0, 20, 40, 6)],
  ])
  expect([...inView(ids, reports)].sort()).toEqual(['a4', 'p5', 't5'])
  // Rows the order doesn't know yet are kept; with nothing known on screen, those alone.
  expect([...inView(ids, new Map([['new', r(0, 3, 4, 7)]]))]).toEqual(['new'])
  expect([...inView(ids, new Map())]).toEqual([])
})
