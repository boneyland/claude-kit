// The queue's files in the player's folder, shared by every program that drives
// the player: queue.json (the list), queue-place.json (where it got to) and
// queue.prev.json (the last cleared list). Each is written whole, to a temp file
// first and then moved over, so no reader sees half of one; a change to the list
// is read-modify-write under queue.lock, so two programs' edits both land.
import type { Host } from './host'
import { paths } from './paths'
import { checkStored, EMPTY_QUEUE, NO_PLACE, parsePlace, parseStored, type Place, type StoredQueue } from './stored'

// A queue lock older than this was left by a program that died mid-edit. An
// edit holds it while mpv is brought along (bounded: a few commands, else a
// rebuild), each command a process in the mod, so it is generous.
export const QUEUE_LOCK_STALE_MS = 60_000
const LOCK_TRY_MS = 50
// How long an update waits for the lock before it says the queue is busy.
export const QUEUE_LOCK_WAIT_MS = 10_000

// Creates `lockPath` only if absent (O_EXCL, by the shell's noclobber), or
// takes it over when older than `staleMs`.
export async function takeFileLock(h: Host, lockPath: string, staleMs: number): Promise<boolean> {
  const now = await h.now().catch(() => 0)
  const create = async () =>
    (await h.run(['sh', '-c', 'set -C; printf %s "$1" > "$2"', 'sh', String(now), lockPath]).catch(() => undefined))?.exitCode === 0
  if (await create()) return true
  const stat = await h.fs.stat(lockPath).catch(() => undefined)
  if (!stat || now - stat.mtimeMs < staleMs) return false
  await h.run(['rm', '-f', lockPath]).catch(() => undefined)
  return create()
}

export async function releaseFileLock(h: Host, lockPath: string): Promise<void> {
  await h.run(['rm', '-f', lockPath]).catch(() => undefined)
}

// Runs `fn` holding the lock file, trying every 50 ms for 10 s; 'busy' when it
// could not be had. The lock is released however `fn` ends.
export async function withFileLock<T>(h: Host, lockPath: string, staleMs: number, fn: () => Promise<T>): Promise<T | 'busy'> {
  let waited = 0
  while (!(await takeFileLock(h, lockPath, staleMs))) {
    if (waited >= QUEUE_LOCK_WAIT_MS) return 'busy'
    await h.sleep(LOCK_TRY_MS)
    waited += LOCK_TRY_MS
  }
  try {
    return await fn()
  } finally {
    await releaseFileLock(h, lockPath)
  }
}

// Whole-file write: temp file, then moved over `path`.
export async function writeWhole(h: Host, path: string, text: string): Promise<void> {
  const tmp = `${path}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    await h.fs.write(tmp, text)
    const moved = await h.run(['mv', '-f', tmp, path], { timeoutMs: 3000 })
    if (moved.exitCode !== 0) throw new Error(moved.stderr)
  } catch (error) {
    h.log(`stream-radio: could not save ${path}: ${error instanceof Error ? error.message : String(error)}`, 'debug')
    await h.run(['rm', '-f', tmp], { timeoutMs: 3000 }).catch(() => undefined)
    throw error
  }
}

// Never throws: missing, unreadable or broken reads as the empty queue.
export async function readStored(h: Host): Promise<StoredQueue> {
  try {
    return parseStored(await h.fs.read((await paths(h)).queueJson))
  } catch {
    return EMPTY_QUEUE
  }
}

// The queue as an edit reads it, under the lock: a missing file is the empty
// queue, but one that is there and cannot be read (a passing error, a queue a
// newer version wrote) throws, so the edit fails and the file is not written
// over. A broken file is moved aside to queue.json.broken, so it can be looked
// at, and the edit goes on from empty.
async function readForEdit(h: Host, queueJson: string): Promise<StoredQueue> {
  let text: string
  try {
    text = await h.fs.read(queueJson)
  } catch (error) {
    if (!(await h.fs.exists(queueJson).catch(() => true))) return EMPTY_QUEUE
    throw error
  }
  const q = checkStored(text)
  if (q === 'newer') throw new Error(`${queueJson} was written by a newer stream-radio; update this one.`)
  if (q === 'broken') {
    const moved = await h.run(['mv', '-f', queueJson, `${queueJson}.broken`], { timeoutMs: 3000 })
    if (moved.exitCode !== 0) throw new Error(`${queueJson} is broken and could not be moved aside: ${moved.stderr}`)
    h.log(`stream-radio: ${queueJson} was broken; moved it to ${queueJson}.broken and started an empty queue.`, 'debug')
    return EMPTY_QUEUE
  }
  return q
}

// One update at a time in this program as well as across programs.
let chain: Promise<unknown> = Promise.resolve()

// Under the lock: reads the queue, applies `fn`, writes the result whole.
// Resolves to what was written, or to the queue as it is when `fn` left the rev
// alone (nothing written); 'busy' when the lock could not be had. Throws when
// the file could not be written.
export function updateStored(h: Host, fn: (q: StoredQueue) => StoredQueue): Promise<StoredQueue | 'busy'> {
  return updateStoredWith(h, async q => fn(q))
}

// The same, with an `fn` that may wait (on the player, say) while it holds the
// lock, and `after`, run still holding it once what `fn` made is written (not
// when `fn` left the rev alone): what must follow the file before anyone else
// reads or changes it.
export function updateStoredWith(
  h: Host,
  fn: (q: StoredQueue) => Promise<StoredQueue>,
  after?: (q: StoredQueue, was: StoredQueue) => Promise<void>,
): Promise<StoredQueue | 'busy'> {
  const step = chain.then(async () => {
    const p = await paths(h)
    return withFileLock(h, p.queueLock, QUEUE_LOCK_STALE_MS, async () => {
      const was = await readForEdit(h, p.queueJson)
      const next = await fn(was)
      if (next.rev === was.rev) return was
      await writeWhole(h, p.queueJson, `${JSON.stringify(next)}\n`)
      await after?.(next, was)
      return next
    })
  })
  chain = step.catch(() => undefined)
  return step
}

export async function readPlace(h: Host): Promise<Place> {
  try {
    return parsePlace(await h.fs.read((await paths(h)).place))
  } catch {
    return NO_PLACE
  }
}

// No lock: the place is one program's last word, and never bumps the list's rev.
// Not written when it is what is on disk.
export async function writePlace(h: Host, place: Place): Promise<void> {
  const on = await readPlace(h)
  if (on.rev === place.rev && on.current === place.current && on.seconds === place.seconds) return
  await writeWhole(h, (await paths(h)).place, `${JSON.stringify(place)}\n`)
}

// Clearing: the queue goes to queue.prev.json and the queue is emptied (rev + 1).
// 'busy' when the lock could not be had: nothing changed.
export async function backUpAndEmpty(h: Host): Promise<'busy' | void> {
  const p = await paths(h)
  const done = await updateStoredWith(h, async q => {
    if (q.entries.length > 0) await writeWhole(h, p.prev, `${JSON.stringify(q)}\n`)
    return { ...EMPTY_QUEUE, rev: q.rev + 1 }
  })
  if (done === 'busy') return 'busy'
}

// Brings the cleared queue back (rev + 1 over the empty one); false when there
// is no backup, 'busy' when the lock could not be had (nothing changed). Its
// entries keep their ids, made at revs up to its own; the rev goes past that
// too, so no later add makes one of those ids again (the queue file may have
// started over meanwhile, from a lower rev).
export async function restorePrev(h: Host): Promise<boolean | 'busy'> {
  const p = await paths(h)
  const prev = await h.fs.read(p.prev).then(parseStored, () => EMPTY_QUEUE)
  if (prev.entries.length === 0) return false
  const done = await updateStored(h, q => ({ ...prev, rev: Math.max(q.rev, prev.rev, highestIdRev(prev)) + 1 }))
  return done === 'busy' ? 'busy' : true
}

// The highest rev an entry's id was made at (ids are `rev.i`); 0 for none.
function highestIdRev(q: StoredQueue): number {
  let most = 0
  for (const e of q.entries) {
    const rev = Number(e.id.split('.')[0])
    if (Number.isInteger(rev) && rev > most) most = rev
  }
  return most
}
