// What is kept across sessions, in state.json in the player's folder, shared by
// every program that drives the player (the mod, the TUI): the last URL and
// where it got to, the volume and repeat. The values that depend on a setting
// (the default stream, the Volume setting) are kept per program, so two
// programs with different settings never undo each other's saved state.
import type { Host, Resume } from './host'
import type { Repeat } from './nowplaying'
import { paths } from './paths'

export type SavedState = {
  version: 1
  last: { url: string; resumeAt: Resume } | null
  // the default stream each program last started with
  knownDefault: { mod?: string; tui?: string }
  // configured: the Volume setting each program last set the volume under
  volume: { value: number; configured: { mod?: number; tui?: number } } | null
  repeat: Repeat | null
}

const empty = (): SavedState => ({ version: 1, last: null, knownDefault: {}, volume: null, repeat: null })
const NO_AT: Resume = { url: '', index: -1, seconds: -1, title: '' }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Each program's entry of `v`, the ones that pass `is`.
function perProgram<T>(v: unknown, is: (x: unknown) => x is T): { mod?: T; tui?: T } {
  const out: { mod?: T; tui?: T } = {}
  if (!isObject(v)) return out
  if (is(v.mod)) out.mod = v.mod
  if (is(v.tui)) out.tui = v.tui
  return out
}
const isString = (x: unknown): x is string => typeof x === 'string'
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isRepeat = (x: unknown): x is Repeat => x === 'all' || x === 'one' || x === 'off'

function resumeOf(v: unknown): Resume {
  if (!isObject(v) || !isString(v.url) || !isNumber(v.index) || !isNumber(v.seconds)) return NO_AT
  return { url: v.url, index: v.index, seconds: v.seconds, title: isString(v.title) ? v.title : '' }
}

// Field by field: a field of the wrong shape is dropped, the rest kept.
function parse(v: unknown): SavedState {
  const s = empty()
  if (!isObject(v)) return s
  if (isObject(v.last) && isString(v.last.url) && v.last.url) s.last = { url: v.last.url, resumeAt: resumeOf(v.last.resumeAt) }
  s.knownDefault = perProgram(v.knownDefault, isString)
  if (isObject(v.volume) && isNumber(v.volume.value)) s.volume = { value: v.volume.value, configured: perProgram(v.volume.configured, isNumber) }
  if (isRepeat(v.repeat)) s.repeat = v.repeat
  return s
}

// Never throws: missing, unreadable or broken reads as the empty state.
export async function readSaved(h: Host): Promise<SavedState> {
  try {
    return parse(JSON.parse(await h.fs.read((await paths(h)).state)))
  } catch {
    return empty()
  }
}

// One update at a time in this program: two at once would each write what
// the other had not seen yet.
let queue: Promise<unknown> = Promise.resolve()

// Reads again, applies `fn` and writes the result whole: to a temp file first,
// then moved over state.json, so no reader ever sees half of it.
export function updateSaved(h: Host, fn: (s: SavedState) => SavedState): Promise<void> {
  const step = queue.then(async () => {
    const path = (await paths(h)).state
    const next = fn(await readSaved(h))
    const tmp = `${path}.${Math.random().toString(36).slice(2, 10)}.tmp`
    try {
      await h.fs.write(tmp, `${JSON.stringify(next)}\n`)
      const moved = await h.run(['mv', '-f', tmp, path], { timeoutMs: 3000 })
      if (moved.exitCode !== 0) throw new Error(moved.stderr)
    } catch {
      await h.run(['rm', '-f', tmp], { timeoutMs: 3000 }).catch(() => undefined)
    }
  })
  queue = step.catch(() => undefined)
  return step.catch(() => undefined)
}

// The mod kept these in Claude Code's store before state.json: on its first
// start without state.json it copies them over, so nothing saved is lost.
// Resolves to whether it did.
export async function migrateFromStore(h: Host, store: { get(key: string): Promise<unknown> }): Promise<boolean> {
  const isThere = await h.fs.exists((await paths(h)).state).catch(() => true)
  if (isThere) return false
  const get = (key: string) => store.get(key).catch(() => undefined)
  const [last, volume, repeat] = [await get('last'), await get('volume'), await get('repeat')]
  if (last === undefined && volume === undefined && repeat === undefined) return false
  const from = parse({
    last,
    knownDefault: { mod: isObject(last) ? last.knownDefault : undefined },
    volume: isObject(volume) ? { value: volume.value, configured: { mod: volume.configured } } : undefined,
    repeat,
  })
  await updateSaved(h, () => from)
  return true
}
