// Where the plan's 5-hour and weekly windows end at the current pace, and how
// well that guess did once a window reset. Pure: no engine calls.
//
// Readings are the plan's own `used %` (Claude Code's rate limits), saved each
// time a window moves, by every session. A projection blends the recent pace
// (the last hour of a 5-hour window, the last day of a week) with the pace
// since the window began; the window's average alone, a straight line from its
// start, is projected too, and both are scored when the window resets.

export type Kind = 'five_hour' | 'seven_day'
// [time ms, percent used]
export type Sample = [number, number]
export type Mark = '25' | '50' | '75'
export type Check = { blend: number; linear: number }
export type PaceWindow = { resetsAt: number; samples: Sample[]; checks: Partial<Record<Mark, Check>> }
export type PaceRecord = { kind: Kind; resetsAt: number; final: number; checks: Partial<Record<Mark, Check>> }

export const KINDS: readonly Kind[] = ['five_hour', 'seven_day']
export const WINDOW_MS: Record<Kind, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86_400_000 }
// The recent pace: this far back.
const LOOKBACK_MS: Record<Kind, number> = { five_hour: 3600_000, seven_day: 86_400_000 }
// Readings spanning less than this give no recent pace.
const MIN_SPAN_MS: Record<Kind, number> = { five_hour: 20 * 60_000, seven_day: 6 * 3600_000 }
// Too early in a window to say anything.
const MIN_ELAPSED_MS: Record<Kind, number> = { five_hour: 30 * 60_000, seven_day: 12 * 3600_000 }
// The recent pace's weight in the blend; the window's average has the rest.
export const RECENT_WEIGHT = 0.6
const MAX_SAMPLES = 400
// An unchanged reading is kept again only after this long, to show the idle time.
const REPEAT_MS = 30 * 60_000
// Reset times within this of each other are the same window.
const SAME_WINDOW_MS = 10 * 60_000
const MARKS: readonly Mark[] = ['25', '50', '75']
// A mark is scored only when a reading lands this close after it.
const MARK_SLACK = 0.15
export const HISTORY_KEPT = 40

export type Projection = {
  kind: Kind
  used: number
  // End-of-window percent: the blend, and the straight line from the window's start.
  projected: number
  linear: number
  // Percent per hour, as blended.
  ratePerHour: number
  // When 100% is reached at the blended pace, if before the reset.
  runOutAt: number | null
  resetsAt: number
  // How much of the window has passed, 0 to 1.
  fraction: number
}

// A reading: kept in its window, or it starts a new one and the old one is
// finished, its highest reading what it ended at.
export const addSample = (w: PaceWindow | null, kind: Kind, resetsAt: number, t: number, pct: number) => {
  if (w !== null && Math.abs(w.resetsAt - resetsAt) <= SAME_WINDOW_MS) {
    const last = w.samples[w.samples.length - 1]
    if (last !== undefined && (t < last[0] || (last[1] === pct && t - last[0] < REPEAT_MS))) {
      return { window: w, finished: null, isChanged: false }
    }
    return { window: { ...w, samples: [...w.samples, [t, pct] as Sample].slice(-MAX_SAMPLES) }, finished: null, isChanged: true }
  }
  // A reading of a window older than the one kept: a stale session's; dropped.
  if (w !== null && resetsAt < w.resetsAt) return { window: w, finished: null, isChanged: false }
  const finished: PaceRecord | null =
    w !== null && w.samples.length > 0 ? { kind, resetsAt: w.resetsAt, final: Math.max(...w.samples.map(s => s[1])), checks: w.checks } : null
  return { window: { resetsAt, samples: [[t, pct] as Sample], checks: {} }, finished, isChanged: true }
}

export const project = (kind: Kind, w: PaceWindow | null, now: number): Projection | null => {
  if (w === null || w.samples.length === 0) return null
  const len = WINDOW_MS[kind]
  const remaining = w.resetsAt - now
  const elapsed = len - remaining
  if (remaining <= 0 || elapsed < MIN_ELAPSED_MS[kind]) return null

  const used = w.samples[w.samples.length - 1]![1]
  const linearRate = used / elapsed

  // The recent pace: from the reading that stood `LOOKBACK` ago (or the first,
  // when the readings span enough) to now. No change since the last reading is
  // read as no use since.
  const from = now - LOOKBACK_MS[kind]
  const before = [...w.samples].reverse().find(s => s[0] <= from)
  const first = w.samples[0]!
  const base: Sample | null = before !== undefined ? [from, before[1]] : now - first[0] >= MIN_SPAN_MS[kind] ? first : null
  const recentRate = base === null ? null : Math.max(0, used - base[1]) / (now - base[0])

  const rate = recentRate === null ? linearRate : RECENT_WEIGHT * recentRate + (1 - RECENT_WEIGHT) * linearRate
  const projected = used + rate * remaining
  const runOutAt = used >= 100 ? now : projected >= 100 && rate > 0 ? now + (100 - used) / rate : null
  return {
    kind,
    used,
    projected,
    linear: used + linearRate * remaining,
    ratePerHour: rate * 3600_000,
    runOutAt,
    resetsAt: w.resetsAt,
    fraction: elapsed / len,
  }
}

// Notes the projection at a quarter, half and three quarters of the window,
// once each, to score when the window resets.
export const checkpoint = (w: PaceWindow, p: Projection | null): PaceWindow => {
  if (p === null) return w
  const due = MARKS.filter(m => w.checks[m] === undefined && p.fraction >= Number(m) / 100 && p.fraction < Number(m) / 100 + MARK_SLACK)
  if (due.length === 0) return w
  const checks = { ...w.checks }
  for (const m of due) checks[m] = { blend: round1(p.projected), linear: round1(p.linear) }
  return { ...w, checks }
}

const round1 = (n: number) => Math.round(n * 10) / 10

// How far each model's projection at each mark was from where the window ended,
// in percentage points, over the finished windows of a kind. Over 100 counts as 100.
export const accuracy = (history: readonly PaceRecord[], kind: Kind) =>
  MARKS.map(mark => {
    const scored = history.filter(r => r.kind === kind && r.checks[mark] !== undefined)
    const err = (model: keyof Check) =>
      scored.length === 0 ? null : scored.reduce((sum, r) => sum + Math.abs(Math.min(100, r.checks[mark]![model]) - r.final), 0) / scored.length
    return { mark, windows: scored.length, blend: err('blend'), linear: err('linear') }
  })

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

// `15:20` today, `Mon 15:20` another day; at the given offset from UTC, in minutes.
export const when = (t: number, now: number, offsetMinutes: number) => {
  const d = new Date(t + offsetMinutes * 60_000)
  const today = new Date(now + offsetMinutes * 60_000)
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  const isToday = d.getUTCFullYear() === today.getUTCFullYear() && d.getUTCMonth() === today.getUTCMonth() && d.getUTCDate() === today.getUTCDate()
  return isToday ? time : `${DAYS[d.getUTCDay()]} ${time}`
}

// 3d, 14h, 2h10m, 45m.
export const span = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes >= 48 * 60) return `${Math.round(minutes / 1440)}d`
  if (minutes >= 10 * 60) return `${Math.round(minutes / 60)}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
  return `${minutes}m`
}

const LABEL: Record<Kind, string> = { five_hour: '5-hour', seven_day: 'weekly' }

// The heads-up: shown only when the window runs out before it resets.
export const runOutWarning = (p: Projection | null, now: number, offsetMinutes: number) => {
  if (p === null || p.runOutAt === null) return null
  return {
    kind: 'pace' as const,
    text:
      p.used >= 100
        ? `The ${LABEL[p.kind]} limit is used up until ${when(p.resetsAt, now, offsetMinutes)}`
        : `Heads up: at this pace you'll hit the ${LABEL[p.kind]} limit ${when(p.runOutAt, now, offsetMinutes)}, ${span(p.resetsAt - p.runOutAt)} before it resets`,
  }
}

// One line per window, for `/session_data pace`.
export const describe = (p: Projection | null, kind: Kind, now: number, offsetMinutes: number) => {
  if (p === null) return `${LABEL[kind]}: too early in the window, or no readings yet.`
  const end =
    p.runOutAt !== null
      ? `runs out ${when(p.runOutAt, now, offsetMinutes)}, ${span(p.resetsAt - p.runOutAt)} before the reset`
      : `ends near ${Math.round(p.projected)}%, with room to spare`
  return `${LABEL[kind]}: ${Math.round(p.used)}% used, ${Math.round(p.fraction * 100)}% through; ${p.ratePerHour.toFixed(1)}%/h → ${end} (straight line: ${Math.round(Math.min(p.linear, 999))}%). Resets ${when(p.resetsAt, now, offsetMinutes)}.`
}

export const describeAccuracy = (history: readonly PaceRecord[], kind: Kind) => {
  const rows = accuracy(history, kind).filter(r => r.windows > 0)
  if (rows.length === 0) return `${LABEL[kind]} accuracy: no finished window scored yet.`
  const pts = (n: number | null) => (n === null ? '—' : `±${n.toFixed(1)}`)
  return [
    `${LABEL[kind]} accuracy (mean miss in points; blend vs straight line):`,
    ...rows.map(r => `  at ${r.mark}% through: ${pts(r.blend)} vs ${pts(r.linear)}  (${r.windows} window${r.windows === 1 ? '' : 's'})`),
  ].join('\n')
}
