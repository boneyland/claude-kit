// Where the plan's 5-hour and weekly windows end at the current pace, and how
// well each way of guessing did once a window reset. Pure: no engine calls.
//
// Readings are the plan's own `used %` (Claude Code's rate limits), saved each
// time a window moves, by every session. Four forecasts of where a window ends,
// each noted at 25/50/75% through and scored when it resets (rolling-origin
// evaluation; the score is the mean absolute miss, in points):
//
// - smooth:  used + an exponentially smoothed rate × time left. Simple exponential
//            smoothing of the usage rate in continuous time: every stretch of the
//            window counts, weighted by e^(-age/τ). (Hyndman & Athanasopoulos,
//            Forecasting: Principles and Practice, ch. 8.)
// - linear:  the window's average rate carried to the end: the run rate.
// - snaive:  seasonal naive: what the last window used from this point to its end.
//            The baseline any model should beat.
// - profile: weekly only: an hour-of-week usage profile learned from finished
//            weeks, scaled by how this week runs against it (multiplicative
//            seasonality with a level; Holt–Winters' idea, by hour of week).

export type Kind = 'five_hour' | 'seven_day'
// [time ms, percent used]
export type Sample = [number, number]
export type Mark = '25' | '50' | '75'
export type Model = 'smooth' | 'linear' | 'snaive' | 'profile'
export type Check = Partial<Record<Model, number>>
// `cutAt`: the last reading before a free reset (from the app) put the window back
// near 0 without moving its reset time; the window's end and pace count from there.
export type PaceWindow = { resetsAt: number; samples: Sample[]; checks: Partial<Record<Mark, Check>>; cutAt?: number }
export type PaceRecord = { kind: Kind; resetsAt: number; final: number; checks: Partial<Record<Mark, Check>> }
// Percentage points used in each hour of the week (0 = Sunday 00:00 local), summed
// over `weeks` finished weeks.
export type Profile = { points: number[]; weeks: number }

export const KINDS: readonly Kind[] = ['five_hour', 'seven_day']
export const MODELS: readonly Model[] = ['smooth', 'linear', 'snaive', 'profile']
export const WINDOW_MS: Record<Kind, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86_400_000 }
// The smoothing time constant: usage this old weighs 1/e of now's.
export const TAU_MS: Record<Kind, number> = { five_hour: 3600_000, seven_day: 86_400_000 }
// Too early in a window to say anything.
const MIN_ELAPSED_MS: Record<Kind, number> = { five_hour: 30 * 60_000, seven_day: 12 * 3600_000 }
// Finished weeks the profile needs before it is the weekly projection.
export const PROFILE_MIN_WEEKS = 2
// How far this week's level may scale the profile.
const LEVEL_MIN = 0.5
const LEVEL_MAX = 2
// Profile points expected so far below which the level is not measured.
const LEVEL_MIN_POINTS = 2
const HOURS = 168
const HOUR = 3600_000
const MAX_SAMPLES = 400
// An unchanged reading is kept again only after this long, to show the idle time.
const REPEAT_MS = 30 * 60_000
// Reset times within this of each other are the same window.
const SAME_WINDOW_MS = 10 * 60_000
// A reading this many points under the window's highest is a free reset; a smaller
// dip is the plan's rounding.
const RESET_DROP = 5
const MARKS: readonly Mark[] = ['25', '50', '75']
// A mark is noted only when a reading lands this close after it.
const MARK_SLACK = 0.15
export const HISTORY_KEPT = 40

export type Projection = {
  kind: Kind
  used: number
  // End-of-window percent by each model; null where a model has nothing to go on.
  models: Record<Model, number | null>
  // The model shown, its end-of-window percent, and when it reaches 100% if before the reset.
  shown: Model
  projected: number
  runOutAt: number | null
  // The smoothed rate, percent per hour.
  ratePerHour: number
  resetsAt: number
  // How much of the window has passed, 0 to 1.
  fraction: number
}

export type Context = { prev: PaceWindow | null; profile: Profile | null; offsetMinutes: number }

// A reading: kept in its window, or it starts a new one and the old one is
// finished, its highest reading what it ended at. A reading well under the
// window's highest, at the same reset time, is a free reset: the window is cut
// there (`cut`), and scored only if it was used up, the one end that is known.
type Added = { window: PaceWindow; finished: PaceRecord | null; cut: PaceRecord | null; isChanged: boolean }
export const addSample = (w: PaceWindow | null, kind: Kind, resetsAt: number, t: number, pct: number): Added => {
  if (w !== null && Math.abs(w.resetsAt - resetsAt) <= SAME_WINDOW_MS) {
    const last = w.samples[w.samples.length - 1]
    if (last !== undefined && (t < last[0] || (last[1] === pct && t - last[0] < REPEAT_MS))) {
      return { window: w, finished: null, cut: null, isChanged: false }
    }
    const samples = [...w.samples, [t, pct] as Sample].slice(-MAX_SAMPLES)
    if (last !== undefined && t > last[0] && sinceCut(w).length > 0 && pct <= finalOf(w) - RESET_DROP) {
      const final = finalOf(w)
      const cut: PaceRecord | null = final >= 100 ? { kind, resetsAt: last[0], final, checks: w.checks } : null
      return { window: { ...w, samples, checks: {}, cutAt: last[0] }, finished: null, cut, isChanged: true }
    }
    return { window: { ...w, samples }, finished: null, cut: null, isChanged: true }
  }
  // A reading of a window older than the one kept: a stale session's; dropped.
  if (w !== null && resetsAt < w.resetsAt) return { window: w, finished: null, cut: null, isChanged: false }
  const finished: PaceRecord | null =
    w !== null && sinceCut(w).length > 0 ? { kind, resetsAt: w.resetsAt, final: finalOf(w), checks: w.checks } : null
  return { window: { resetsAt, samples: [[t, pct] as Sample], checks: {} }, finished, cut: null, isChanged: true }
}

// The readings since the last free reset: all of them in a window never cut.
const sinceCut = (w: PaceWindow) => (w.cutAt === undefined ? w.samples : w.samples.filter(s => s[0] > w.cutAt!))

export const finalOf = (w: PaceWindow) => Math.max(...sinceCut(w).map(s => s[1]))

// Where the window's own time starts: its reset time less its length, or the last
// reading before a free reset.
const startOf = (kind: Kind, w: PaceWindow) => w.cutAt ?? w.resetsAt - WINDOW_MS[kind]

// The window as stretches of time with the points used in each: from its start
// (0%) through the readings, then flat to `end`. Use between readings is taken
// as even.
type Segment = { t0: number; t1: number; du: number }
const segmentsOf = (kind: Kind, w: PaceWindow, end: number): Segment[] => {
  const start = w.resetsAt - WINDOW_MS[kind]
  const points: Sample[] = [[start, 0], ...w.samples.filter(s => s[0] >= start && s[0] <= end)]
  const last = points[points.length - 1]!
  if (end > last[0]) points.push([end, last[1]])
  const segs: Segment[] = []
  for (let i = 1; i < points.length; i++) {
    const [t0, u0] = points[i - 1]!
    const [t1, u1] = points[i]!
    if (t1 > t0) segs.push({ t0, t1, du: Math.max(0, u1 - u0) })
  }
  return segs
}

// The usage rate, exponentially smoothed: each stretch's rate weighted by
// ∫ e^(-(now - t)/τ) dt over it. Per ms; null with no time to go on.
export const smoothRate = (segs: readonly Segment[], now: number, tau: number) => {
  let num = 0
  let den = 0
  for (const s of segs) {
    const weight = tau * (Math.exp(-(now - s.t1) / tau) - Math.exp(-(now - s.t0) / tau))
    num += (s.du / (s.t1 - s.t0)) * weight
    den += weight
  }
  return den > 0 ? num / den : null
}

// The hour of the week, 0 = Sunday 00:00, at the given offset from UTC in minutes.
export const hourOfWeek = (t: number, offsetMinutes: number) => {
  const d = new Date(t + offsetMinutes * 60_000)
  return d.getUTCDay() * 24 + d.getUTCHours()
}

// Spreads each stretch's points over the hours of the week it covers.
const eachHour = (t0: number, t1: number, offsetMinutes: number, f: (hour: number, ms: number, at: number) => void) => {
  let t = t0
  while (t < t1) {
    const local = t + offsetMinutes * 60_000
    const next = Math.min(t1, t + (HOUR - (((local % HOUR) + HOUR) % HOUR)))
    f(hourOfWeek(t, offsetMinutes), next - t, t)
    t = next
  }
}

// A finished week added to the profile.
export const learnWeek = (profile: Profile | null, w: PaceWindow, offsetMinutes: number): Profile => {
  const points = profile?.points.length === HOURS ? [...profile.points] : new Array<number>(HOURS).fill(0)
  for (const s of segmentsOf('seven_day', w, w.resetsAt)) {
    const perMs = s.du / (s.t1 - s.t0)
    if (perMs > 0) eachHour(s.t0, s.t1, offsetMinutes, (h, ms) => (points[h] = points[h]! + perMs * ms))
  }
  return { points, weeks: (profile?.weeks ?? 0) + 1 }
}

// Points the profile expects between two times: its average week.
const expected = (profile: Profile, t0: number, t1: number, offsetMinutes: number) => {
  let sum = 0
  eachHour(t0, t1, offsetMinutes, (h, ms) => (sum += (profile.points[h]! / profile.weeks) * (ms / HOUR)))
  return sum
}

// What the window held at a time, use between readings taken as even (as in
// segmentsOf): from 0 at the window's start, through the readings, flat after the last.
const usedAt = (kind: Kind, w: PaceWindow, t: number) => {
  let [t0, u0]: Sample = [w.resetsAt - WINDOW_MS[kind], 0]
  if (t <= t0) return 0
  for (const [t1, u1] of w.samples) {
    if (t1 < t0) continue
    if (t <= t1) return t1 === t0 ? u1 : u0 + (u1 - u0) * ((t - t0) / (t1 - t0))
    ;[t0, u0] = [t1, u1]
  }
  return u0
}

export const project = (kind: Kind, w: PaceWindow | null, now: number, ctx: Context): Projection | null => {
  if (w === null || w.samples.length === 0) return null
  const len = WINDOW_MS[kind]
  const start = startOf(kind, w)
  const remaining = w.resetsAt - now
  const elapsed = now - start
  if (remaining <= 0 || elapsed < MIN_ELAPSED_MS[kind]) return null

  const used = w.samples[w.samples.length - 1]![1]
  const rate = smoothRate(segmentsOf(kind, w, now), now, TAU_MS[kind]) ?? used / elapsed
  const smooth = used + rate * remaining
  const linear = used + (used / elapsed) * remaining

  // The last window, at the same point through it. A week must be the one just before.
  const prev = ctx.prev
  const isPrevUsable =
    prev !== null && prev.samples.length > 0 && prev.cutAt === undefined && w.cutAt === undefined && prev.resetsAt < w.resetsAt && (kind === 'five_hour' || Math.abs(prev.resetsAt + len - w.resetsAt) <= HOUR)
  const snaive = isPrevUsable ? used + Math.max(0, finalOf(prev) - usedAt(kind, prev, prev.resetsAt - len + elapsed)) : null

  // The weekly profile, scaled by how this week runs against it.
  const profile = kind === 'seven_day' && ctx.profile !== null && ctx.profile.weeks >= PROFILE_MIN_WEEKS ? ctx.profile : null
  let level = 1
  let profiled: number | null = null
  if (profile !== null) {
    const soFar = expected(profile, start, now, ctx.offsetMinutes)
    if (soFar >= LEVEL_MIN_POINTS) level = Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, used / soFar))
    profiled = used + level * expected(profile, now, w.resetsAt, ctx.offsetMinutes)
  }

  const shown: Model = profiled !== null ? 'profile' : 'smooth'
  const projected = profiled ?? smooth

  let runOutAt: number | null = null
  if (used >= 100) runOutAt = now
  else if (projected >= 100) {
    if (profile !== null) {
      // Hour by hour until the profile's points reach the limit.
      let sum = used
      eachHour(now, w.resetsAt, ctx.offsetMinutes, (h, ms, at) => {
        if (runOutAt !== null) return
        const add = level * (profile.points[h]! / profile.weeks) * (ms / HOUR)
        // Crossed within this stretch: at the share of it the remaining points need.
        if (add > 0 && sum + add >= 100) runOutAt = at + ms * ((100 - sum) / add)
        sum += add
      })
    } else if (rate > 0) runOutAt = now + (100 - used) / rate
  }

  return {
    kind,
    used,
    models: { smooth, linear, snaive, profile: profiled },
    shown,
    projected,
    runOutAt,
    ratePerHour: rate * HOUR,
    resetsAt: w.resetsAt,
    fraction: elapsed / (w.resetsAt - start),
  }
}

// Notes each model's forecast at a quarter, half and three quarters of the
// window, once each, to score when the window resets.
export const checkpoint = (w: PaceWindow, p: Projection | null): PaceWindow => {
  if (p === null) return w
  const due = MARKS.filter(m => w.checks[m] === undefined && p.fraction >= Number(m) / 100 && p.fraction < Number(m) / 100 + MARK_SLACK)
  if (due.length === 0) return w
  const check: Check = {}
  for (const m of MODELS) {
    const v = p.models[m]
    if (v !== null) check[m] = round1(v)
  }
  const checks = { ...w.checks }
  for (const m of due) checks[m] = check
  return { ...w, checks }
}

const round1 = (n: number) => Math.round(n * 10) / 10

// Each model's mean miss at each mark, in points, over the finished windows of a
// kind that noted it. A forecast over 100 counts as 100: the window cannot pass it.
export const accuracy = (history: readonly PaceRecord[], kind: Kind) =>
  MARKS.map(mark => {
    const records = history.filter(r => r.kind === kind && r.checks[mark] !== undefined)
    const errors = Object.fromEntries(
      MODELS.map(model => {
        const scored = records.filter(r => r.checks[mark]![model] !== undefined)
        const mae = scored.length === 0 ? null : scored.reduce((sum, r) => sum + Math.abs(Math.min(100, r.checks[mark]![model]!) - r.final), 0) / scored.length
        return [model, mae === null ? null : { mae, windows: scored.length }]
      }),
    ) as Record<Model, { mae: number; windows: number } | null>
    return { mark, windows: records.length, errors }
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
export const MODEL_LABEL: Record<Model, string> = { smooth: 'smoothed', linear: 'straight line', snaive: 'last window', profile: 'weekly profile' }

// The heads-up: shown only when the window runs out before it resets.
export const runOutWarning = (p: Projection | null, now: number, offsetMinutes: number) => {
  if (p === null || p.runOutAt === null) return null
  return {
    kind: 'pace' as const,
    text:
      p.used >= 100
        ? `The ${LABEL[p.kind]} limit is used up until ${when(p.resetsAt, now, offsetMinutes)}`
        : `Heads up: ${LABEL[p.kind]} limit runs out ${when(p.runOutAt, now, offsetMinutes)}, ${span(p.resetsAt - p.runOutAt)} before reset`,
  }
}

const pct = (n: number) => `${Math.round(Math.min(n, 999))}%`

// The window's state and every model's forecast, for `/turn-gauge pace`.
export const describe = (p: Projection | null, kind: Kind, now: number, offsetMinutes: number) => {
  if (p === null) return `${LABEL[kind]}: too early in the window, or no readings yet.`
  const end =
    p.runOutAt !== null
      ? `runs out ${when(p.runOutAt, now, offsetMinutes)}, ${span(p.resetsAt - p.runOutAt)} before the reset`
      : `ends near ${pct(p.projected)}, with room to spare`
  const others = MODELS.filter(m => m !== p.shown && p.models[m] !== null).map(m => `${MODEL_LABEL[m]} ${pct(p.models[m]!)}`)
  return [
    `${LABEL[kind]}: ${Math.round(p.used)}% used, ${Math.round(p.fraction * 100)}% through, ${p.ratePerHour.toFixed(1)}%/h smoothed. Resets ${when(p.resetsAt, now, offsetMinutes)}.`,
    `  ${MODEL_LABEL[p.shown]}: ${end}${others.length > 0 ? ` · ${others.join(' · ')}` : ''}`,
  ].join('\n')
}

export const describeAccuracy = (history: readonly PaceRecord[], kind: Kind) => {
  const rows = accuracy(history, kind).filter(r => r.windows > 0)
  if (rows.length === 0) return `${LABEL[kind]} accuracy: no finished window scored yet.`
  return [
    `${LABEL[kind]} accuracy, mean miss in points (windows scored):`,
    ...rows.map(
      r =>
        `  at ${r.mark}% through: ${MODELS.filter(m => r.errors[m] !== null)
          .map(m => `${MODEL_LABEL[m]} ±${r.errors[m]!.mae.toFixed(1)} (${r.errors[m]!.windows})`)
          .join(' · ')}`,
    ),
  ].join('\n')
}
