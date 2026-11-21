import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Prompt } from '../types'

const PANE = 'prompt-index'
const TITLE = 'Prompts'

// Change the tag when a Prompt's fields change: it declines what an earlier
// version stored, which outlives a reload.
const prompts = atom({ plugin: 'prompt-index', key: 'prompts' } as const, [] as Prompt[], {
  shape: 'prompts-1',
})
const query = atom({ plugin: 'prompt-index', key: 'query' } as const, '')
const cursor = atom({ plugin: 'prompt-index', key: 'cursor' } as const, '')
const isOpen = atom({ plugin: 'prompt-index', key: 'isOpen' } as const, false)

// What the transcript's rows reported while drawing. A render hook can't
// write $.state, so these live here; a reload empties them and the next
// redraw of each row fills them again.
// Every row's latest report of where it sits in the viewport (null: off it),
// by requestId, with the report's sequence number: every kind of row, not
// only prompts, so a prompt whose own row has scrolled away still counts
// while its reply is on screen.
type At = { first: number; last: number; of: number }
const seen = new Map<string, { at: At | null; n: number }>()
let seq = 0
const notTyped = new Set<string>()
// Each transcript row's requestId, mapped to the prompt whose section it is
// in, and the rows in transcript order.
let owners = new Map<string, string>()
let order: string[] = []
// The section ids last drawn, so the pane redraws only when they change.
let drawnSections = ''

// A slash command is stored as tags; show it as typed.
const COMMAND = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/

// The prompt as one line, or null for a user row that isn't a prompt
// (tool results, interruptions, command output, notifications).
export const promptLine = (text: string): string | null => {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('[Request interrupted')) return null
  // A prompt with pasted text starts with a tag but is still the person's prompt:
  // dropping it would leave its reply to the command before it.
  if (trimmed.startsWith('<pasted_content')) {
    return trimmed.replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '[pasted text]'
  }
  if (trimmed.startsWith('<')) {
    const command = COMMAND.exec(trimmed)
    if (command === null) return null
    return `${command[1]?.trim() ?? ''} ${command[2]?.trim() ?? ''}`.trim()
  }
  return trimmed.replace(/\s+/g, ' ')
}

export const matches = (list: readonly Prompt[], q: string) => {
  const needle = q.trim().toLowerCase()
  return needle === '' ? list : list.filter(p => p.text.toLowerCase().includes(needle))
}

// The match after (or before) where the reader is: the prompt last jumped to,
// else the last prompt on screen, else the end of the session.
export const step = (
  list: readonly Prompt[],
  hits: readonly Prompt[],
  from: string,
  visible: ReadonlySet<string>,
  dir: 1 | -1,
): Prompt | undefined => {
  if (hits.length === 0) return undefined
  const at = (id: string) => list.findIndex(p => p.id === id)
  let here = from === '' ? -1 : at(from)
  if (here === -1) {
    const shown = list.map((p, i) => (visible.has(p.id) ? i : -1)).filter(i => i >= 0)
    here = (dir === 1 ? shown[shown.length - 1] : shown[0]) ?? list.length
  }
  const ordered = hits.map(h => ({ h, i: at(h.id) }))
  const next =
    dir === 1 ? ordered.find(o => o.i > here) : [...ordered].reverse().find(o => o.i < here)
  // Wrap round, as a search does.
  return (next ?? (dir === 1 ? ordered[0] : ordered[ordered.length - 1]))?.h
}

// Never lets a failed read hold up the prompt or the turn it rides on.
const refresh = ($: EngineInterface) => readPrompts($).catch(() => undefined)

// A slash command is kept only when Claude answered it (a skill, or a command
// that sends a prompt): one Claude Code ran by itself (/plugin, /reload-plugins,
// /exit) leaves no reply before the next prompt. The last command counts as
// answered while a turn runs, its reply still coming. Typed prompts are all kept.
export const promptsOf = (rows: readonly SessionMessage[], skip: ReadonlySet<string>, isTurnRunning = false) => {
  const found: { prompt: Prompt; isCommand: boolean; isAnswered: boolean }[] = []
  for (const row of rows) {
    if (row.role === 'assistant') {
      const last = found[found.length - 1]
      if (last !== undefined) last.isAnswered = true
      continue
    }
    if (row.role !== 'user' || row.uuid === undefined) continue
    if ((row.toolResults?.length ?? 0) > 0 || skip.has(row.uuid)) continue
    const text = promptLine(row.text)
    if (text !== null) found.push({ prompt: { id: row.uuid, text }, isCommand: COMMAND.test(row.text.trim()), isAnswered: false })
  }
  return found
    .filter((f, i) => !f.isCommand || f.isAnswered || (isTurnRunning && i === found.length - 1))
    .map(f => f.prompt)
}

// Which prompt's section each row is in, under the ids the transcript draws
// it by: a message by its uuid, a tool call by its tool_use_id, a collapsed
// group of calls by `collapsed-<uuid>` of the message that made them.
export const ownersOf = (rows: readonly SessionMessage[], list: readonly Prompt[]) => {
  const isPrompt = new Set(list.map(p => p.id))
  const map = new Map<string, string>()
  const ids: string[] = []
  let current: string | undefined
  for (const row of rows) {
    if (row.uuid !== undefined && isPrompt.has(row.uuid)) current = row.uuid
    if (current === undefined) continue
    const mine = [
      ...(row.uuid === undefined ? [] : [row.uuid, `collapsed-${row.uuid}`]),
      ...row.toolUses.map(use => use.tool_use_id),
    ]
    for (const id of mine) {
      if (!map.has(id)) ids.push(id)
      map.set(id, current)
    }
  }
  return { map, order: ids }
}

// The rows really on screen. A row the transcript drops without a scroll
// past it (a jump far away) never reports leaving, so its last report goes
// stale. The row reported last is on screen; walk out from it in transcript
// order, through rows that say they are on screen, and stop at one that says
// it is off, or at the row cut by the viewport's top or bottom edge. Rows
// never reported (not drawn as rows of their own) are stepped over. Rows the
// order doesn't know yet are kept as they say.
export const inView = (
  ids: readonly string[],
  reports: ReadonlyMap<string, { at: At | null; n: number }>,
) => {
  const index = new Map(ids.map((id, i) => [id, i]))
  const shown = new Set<string>()
  let anchor: string | undefined
  let latest = -1
  for (const [id, r] of reports) {
    if (r.at === null) continue
    if (!index.has(id)) shown.add(id)
    else if (r.n > latest) {
      latest = r.n
      anchor = id
    }
  }
  if (anchor === undefined) return shown
  shown.add(anchor)
  const start = index.get(anchor) ?? 0
  const at = reports.get(anchor)?.at
  const walk = (dir: 1 | -1) => {
    for (let i = start + dir; i >= 0 && i < ids.length; i += dir) {
      const id = ids[i] as string
      const r = reports.get(id)
      if (r === undefined) continue
      if (r.at === null) return
      shown.add(id)
      if (dir === -1 ? r.at.first > 0 : r.at.last < r.at.of - 1) return
    }
  }
  if (at !== undefined && at !== null) {
    if (at.first === 0) walk(-1)
    if (at.last >= at.of - 1) walk(1)
  }
  return shown
}

const onScreenNow = () => inView(order, seen)

// The prompts whose sections have a row on screen, in list order. A row the
// map doesn't know yet (one drawn since the last read, in the turn running
// now) counts for the latest prompt when nothing known is on screen.
export const sectionsOn = (
  list: readonly Prompt[],
  map: ReadonlyMap<string, string>,
  shown: ReadonlySet<string>,
) => {
  const ids = new Set<string>()
  let hasUnknown = false
  for (const id of shown) {
    const owner = map.get(id)
    if (owner === undefined) hasUnknown = true
    else ids.add(owner)
  }
  const last = list[list.length - 1]
  if (ids.size === 0 && hasUnknown && last !== undefined) ids.add(last.id)
  return list.filter(p => ids.has(p.id))
}

// The main loop's turn is running: the last command's reply may not be written yet.
let isTurnRunning = false

const readPrompts = async ($: EngineInterface) => {
  const rows = await $.session.messages({ last: 4096 })
  if ('deny' in rows) return
  const list = promptsOf(rows, notTyped, isTurnRunning)
  ;({ map: owners, order } = ownersOf(rows, list))
  await update($, prompts, () => list)
}

const jump = async ($: EngineInterface, id: string) => {
  await update($, cursor, () => id)
  try {
    const moved = await $.ui.scroll({ to: { requestId: id }, block: 'start' })
    if (moved.deny !== undefined) $.ui.toast(`Couldn't jump there: ${moved.deny}`)
  } catch (err) {
    $.ui.toast(`Couldn't jump there: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Opens the pane, or closes it if it is up; shared by /prompts and the footer button.
const toggle = async ($: EngineInterface): Promise<'opened' | 'closed'> => {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
    await update($, isOpen, () => false)
    return 'closed'
  }
  await refresh($)
  await $.ui.open({ id: PANE, title: TITLE })
  await update($, isOpen, () => true)
  return 'opened'
}

// Whether any of a row's own lines is in the viewport. Line 0 is the blank
// line the engine draws above every message, so a row showing only that
// (its text just under the bottom edge) isn't on screen to the reader.
export const showsText = (at: { first: number; last: number } | null | undefined) =>
  at !== undefined && at !== null && at.last >= Math.max(at.first, 1)

// The prompt sections on screen, by their 1-based numbers in the list.
export const showing = (numbers: readonly number[], total: number) =>
  numbers.length === 0
    ? `${total} prompts`
    : numbers.length === 1
      ? `showing ${numbers[0]} of ${total}`
      : `showing ${numbers[0]}-${numbers[numbers.length - 1]} of ${total}`

const cut = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'prompts',
      description: 'Show this session’s prompts in a pane; click one to jump to it',
    })
    // A pane kept up across a reload is still the engine's; match the label to it.
    const isUp = await $.ui
      .panes()
      .then(panes => panes.some(pane => pane.id === PANE))
      .catch(() => false)
    await update($, isOpen, () => isUp)
    await refresh($)
    return started
  })

  on('command.run', { command: 'prompts' }, async $ => {
    const done = await toggle($)
    return { text: `Prompts pane ${done}.` }
  })

  // Keep the button's label in step however the pane opens or closes,
  // the person's own close mark included.
  on('ui.open', { id: PANE }, async ($, e, next) => {
    const opened = await next(e)
    await update($, isOpen, () => true)
    return opened
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isOpen, () => false)
    return closed
  })

  // A button at the right of the prompt footer, after the engine's own mode
  // labels, that opens and closes the pane. The footer takes no keyboard
  // focus, so it is pressed with the mouse; /prompts does the same by key.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const up = await read($, isOpen)
    return (
      <Box flexDirection="row" gap={1}>
        {await next(e)}
        <Button key="toggle" label={up ? 'Hide prompts' : 'Prompts'} onPress={() => toggle($)} />
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    const sent = await next(e)
    await refresh($)
    return sent
  }).catch(($, e, next) => next(e))

  // A turn starting answers the prompt or command before it: list it now.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
      await refresh($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      isTurnRunning = false
      await refresh($)
    }
    return done
  })

  // Note which transcript rows are in the viewport, whatever their kind, and
  // redraw the pane when the set of prompt sections on screen changes.
  on('ui.render', async ($, e, next) => {
    const props = e.props as { onScreen?: At | null }
    if ('onScreen' in props) {
      const at = props.onScreen ?? null
      seen.set(e.requestId, { at: showsText(at) ? at : null, n: seq++ })
      const key = sectionsOn(await read($, prompts), owners, onScreenNow())
        .map(p => p.id)
        .join(' ')
      if (key !== drawnSections) {
        drawnSections = key
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  // Leave each prompt's row as the engine draws it; note only whether the
  // person typed it.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'composer' && e.props.origin.kind !== 'unclassified') {
      if (!notTyped.has(e.requestId)) $.ui.invalidate('ui.render')
      notTyped.add(e.requestId)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, prompts)
    const q = await read($, query)
    const from = await read($, cursor)
    const hits = matches(list, q)
    const isFiltered = q.trim() !== ''
    const width = Math.max(10, e.props.bodyColumns)
    const digits = String(list.length).length
    const sections = new Set(sectionsOn(list, owners, onScreenNow()).map(p => p.id))
    const shownNumbers = list.map((p, i) => (sections.has(p.id) ? i + 1 : 0)).filter(n => n > 0)

    // `typed` is the field's text on Enter, which may not be stored yet.
    // Returns its promise so the handler holds the press until the jump: the
    // engine scrolls the transcript only while answering the person's input.
    const go = async (dir: 1 | -1, typed?: string) => {
      const all = await read($, prompts)
      const target = step(
        all,
        matches(all, typed ?? (await read($, query))),
        await read($, cursor),
        new Set(sectionsOn(all, owners, onScreenNow()).map(p => p.id)),
        dir,
      )
      if (target === undefined) $.ui.toast('No prompt matches.')
      else await jump($, target.id)
    }

    const where = showing(shownNumbers, list.length)

    return (
      <Box flexDirection="column">
        <Input
          key="filter"
          placeholder="filter prompts"
          value={q}
          submitLabel="next match"
          onInput={value => void update($, query, () => value)}
          onSubmit={async value => {
            await update($, query, () => value)
            await go(1, value)
          }}
        />
        <Box flexDirection="row" gap={1}>
          <Button key="prev" onPress={() => go(-1)}>
            ↑ prev
          </Button>
          <Button key="next" onPress={() => go(1)}>
            ↓ next
          </Button>
          <Text dimColor>{isFiltered ? `${hits.length} of ${list.length} match` : where}</Text>
        </Box>
        {list.length === 0 && <Text dimColor>No prompts yet.</Text>}
        {isFiltered && hits.length === 0 && list.length > 0 && (
          <Text dimColor>No prompt matches.</Text>
        )}
        {hits.map(p => {
          const n = list.indexOf(p) + 1
          const isShown = sections.has(p.id)
          const isCursor = p.id === from
          return (
            <Button key={p.id} plain onPress={() => jump($, p.id)}>
              <Text color={isShown ? 'suggestion' : undefined}>{isShown ? '▌' : ' '}</Text>
              <Text dimColor>{String(n).padStart(digits)} </Text>
              <Text bold={isCursor} dimColor={!isShown && !isCursor}>
                {cut(p.text, width - digits - 3)}
              </Text>
            </Button>
          )
        })}
      </Box>
    )
  })
}
