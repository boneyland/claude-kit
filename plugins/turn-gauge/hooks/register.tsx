import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionCompactResult, SessionMessage, Timer, TurnUsage } from 'claude-code'

import type { AgentSpend, Cache, Limit, Pace, Spend, Stats, Tokens } from '../types'
import {
  baselineFromBreakdown,
  cacheMissWarning,
  contextOf,
  formatTokens,
  hitRate,
  missedOf,
  NO_TOKENS,
  outputWarning,
  RATE_WARN,
  expiredWarning,
  formatUsd,
  median,
  overheadWarning,
  predictUsd,
  costPerTurn,
  RECENT_TURNS,
  resumeCost,
  type SpendInputs,
  type SpendWarning,
} from './spend'
import {
  addSample,
  checkpoint,
  describe,
  describeAccuracy,
  HISTORY_KEPT,
  KINDS,
  learnWeek,
  project,
  runOutWarning,
  type Kind,
  type PaceRecord,
  type PaceWindow,
  type Profile,
  type Projection,
} from './pace'

// Responses shorter than this are mostly tool-call stubs: their timing is noise.
const MIN_TOKENS = 20
// A response that arrived in one burst cannot be timed; such readings are dropped.
const MIN_SECONDS = 0.5
const MAX_SPEED = 1000

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_WARN_S = 20 * 60
const CACHE_ALERT_S = 10 * 60
// Minutes left at which the cache expiry is announced, once each per answer.
const CACHE_NOTIFY_MINUTES = [10, 5] as const

const SPEED = '#8b8cf8'
const MONEY = '#4caf6e'
const MUTED = '#8a8f8c'
const CONTEXT = '#5fa8d3'
const CACHE = '#4fb3a9'
const WARN = '#e2a94e'
const ALERT = '#e0846b'

const stats = atom({ plugin: 'turn-gauge', key: 'stats' } as const, {
  turn: 0,
  speed: null,
  turnCost: null,
  total: 0,
  context: 0,
  costAtStart: 0,
} as Stats)

const cache = atom({ plugin: 'turn-gauge', key: 'cache' } as const, {
  expiresAt: null,
  secondsLeft: null,
} as Cache)

// The plan's rate-limit windows as the last response reported them; empty off a subscription.
const limits = atom({ plugin: 'turn-gauge', key: 'limits' } as const, [] as Limit[])

// Closed with ×: stays hidden for the rest of the session.
const isHidden = atom({ plugin: 'turn-gauge', key: 'isHidden' } as const, false)

// A turn is running: the cache stays warm, so no countdown warnings.
const isBusy = atom({ plugin: 'turn-gauge', key: 'isBusy' } as const, false)

// The smallest CACHE_NOTIFY_MINUTES already announced since the last answer; 0 none.
const warned = atom({ plugin: 'turn-gauge', key: 'warned' } as const, 0)

// The effort level the main loop's last request carried; null where none was sent.
const effort = atom({ plugin: 'turn-gauge', key: 'effort' } as const, null as string | null)

// What the long context costs against starting over: the measured inputs of the
// spend warnings, and the running sums that calibrate list prices to the engine's cost.
const spend = atom({ plugin: 'turn-gauge', key: 'spend' } as const, {
  model: null,
  context: null,
  baseline: null,
  isBaselineMeasured: false,
  scale: null,
  recentSteps: [],
  summary: null,
  steps: 0,
  predicted: 0,
  usdAtTurnStart: 0,
  calibPredicted: 0,
  calibObserved: 0,
  dismissedAt: null,
  isFresh: false,
  isCompactPending: false,
} as Spend)

// Token counts and the cache's hit rate: the session's in and out, every loop's;
// per main turn, input by source, output and what the cache missed.
const tokens = atom({ plugin: 'turn-gauge', key: 'tokens' } as const, {
  input: 0,
  output: 0,
  turn: NO_TOKENS,
  last: null,
  prevContext: null,
  prevModel: null,
  cause: null,
  lastCause: null,
  dismissedTurn: -1,
} as Tokens)

// One response's tokens. A main-loop request that did not read the previous one's
// context from the cache missed it; a model switch explains that miss.
const recordTokens = async ($: EngineInterface, usage: TurnUsage, isMain: boolean) => {
  const input = contextOf(usage)
  await update($, tokens, tk => {
    const session = { ...tk, input: tk.input + input, output: tk.output + usage.output_tokens }
    if (!isMain) return session
    const isNewModel = tk.prevModel !== null && tk.prevModel !== usage.model
    const t = tk.turn
    return {
      ...session,
      turn: {
        uncached: t.uncached + usage.input_tokens,
        read: t.read + usage.cache_read_input_tokens,
        write: t.write + usage.cache_creation_input_tokens,
        output: t.output + usage.output_tokens,
        missed: t.missed + missedOf(tk.prevContext, usage),
      },
      prevContext: input,
      prevModel: usage.model,
      cause: tk.cause ?? (isNewModel ? 'model' : null),
    }
  })
}

// Each agent's cost as `$.agent.list()` gave it when the main turn started, and as last seen.
const agentSpend = atom({ plugin: 'turn-gauge', key: 'agentSpend' } as const, { base: {}, seen: {} } as AgentSpend)

// The running turn's subagent cost: what each agent's cost grew by since the turn
// started. An agent the engine has dropped keeps its last reading.
const sampleAgents = async ($: EngineInterface) => {
  const list = await $.agent.list().catch(() => [])
  const now: Record<string, number> = {}
  for (const a of list) if (a.cost !== undefined) now[a.id] = a.cost.usd
  await update($, agentSpend, a => ({ ...a, seen: { ...a.seen, ...now } }))
  const { base, seen } = await read($, agentSpend)
  const agentsCost = Object.entries(seen).reduce((sum, [id, usd]) => sum + Math.max(0, usd - (base[id] ?? 0)), 0)
  await update($, stats, s => (s.agentsCost === agentsCost ? s : { ...s, agentsCost }))
}

const startAgentSpend = async ($: EngineInterface) => {
  const list = await $.agent.list().catch(() => [])
  const base: Record<string, number> = {}
  for (const a of list) if (a.cost !== undefined) base[a.id] = a.cost.usd
  await update($, agentSpend, () => ({ base, seen: base }))
  await update($, stats, s => ({ ...s, agentsCost: 0 }))
}

// Kept across sessions: a fresh session's first request per project, and compaction summaries.
const BASELINE_KEY = (cwd: string) => `baseline:${cwd}`
const SUMMARIES_KEY = 'summaries'
const SAMPLES_KEPT = 5
// The overhead warning, dismissed, returns once the context grew this much more.
const DISMISS_GROWTH = 50_000

// The recent turns' costs live with the band's stats; only the overhead weighs them.
const spendInputs = (s: Spend, recentCosts: readonly number[] = []): SpendInputs => ({
  model: s.model,
  context: s.context,
  baseline: s.baseline,
  scale: s.scale,
  recentSteps: s.recentSteps ?? [],
  recentCosts,
  summary: s.summary,
})

const pushSample = async ($: EngineInterface, key: string, value: number) => {
  const kept = ((await $.store.get(key)) as number[] | undefined) ?? []
  const next = [...(Array.isArray(kept) ? kept : []), value].slice(-SAMPLES_KEPT)
  await $.store.set(key, next)
  return next
}

// `claude-sonnet-5-5` -> `sonnet-5-5`; a date suffix or context tag is dropped.
const shortModel = (model: string) =>
  model.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')

// The Cache mod's own deadline: seeds ours after a reload missed the last turn.complete.
const cacheModExpiresAt = atom({ plugin: 'Cache', key: 'expiresAt' } as const, null)

const ring = (color: string, glyph: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <circle cx="12" cy="12" r="10" fill="none" stroke="${color}" stroke-width="2"/>
    ${glyph}</svg>`

const SPEED_ICON = ring(
  SPEED,
  `<path d="M6.5 15a6 6 0 0 1 11 0" fill="none" stroke="${SPEED}" stroke-width="1.8" stroke-linecap="round"/>
   <path d="M12 15l3-4" stroke="${SPEED}" stroke-width="1.8" stroke-linecap="round"/>`,
)

const MONEY_ICON = ring(
  MONEY,
  `<text x="12" y="16.5" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="13" font-weight="600" fill="${MONEY}">$</text>`,
)

// The ring itself fills with the context, around a page of lines.
const contextIcon = (percent: number) => {
  const c = 2 * Math.PI * 10
  const filled = (Math.min(100, percent) / 100) * c
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <circle cx="12" cy="12" r="10" fill="none" stroke="${MUTED}" stroke-opacity="0.35" stroke-width="2"/>
    <circle cx="12" cy="12" r="10" fill="none" stroke="${CONTEXT}" stroke-width="2" stroke-linecap="round"
      stroke-dasharray="${filled.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 12 12)"/>
    <g stroke="${CONTEXT}" stroke-width="1.6" stroke-linecap="round">
      <path d="M8.5 9h7M8.5 12h7M8.5 15h4.5"/>
    </g></svg>`
}

// An hourglass: the prompt cache running out.
const cacheIcon = (color: string) =>
  ring(
    color,
    `<g fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">
       <path d="M8.5 6.5h7M8.5 17.5h7"/>
       <path d="M9.5 6.5c0 3 5 3.5 5 5.5s-5 2.5-5 5.5M14.5 6.5c0 3-5 3.5-5 5.5s5 2.5 5 5.5"/>
     </g>`,
  )

const pad = (n: number) => String(n).padStart(2, '0')

// The context fill's color, on both surfaces: green under 45%, yellow under 65%,
// orange under 85%, red from 85%.
const BAR_GREEN = '#4caf6e'
const BAR_YELLOW = '#e6c547'
const BAR_ORANGE = '#e8913a'
const BAR_RED = '#e0605a'
export const contextColor = (percent: number) =>
  percent >= 85 ? BAR_RED : percent >= 65 ? BAR_ORANGE : percent >= 45 ? BAR_YELLOW : BAR_GREEN

const contextBar = (percent: number) => {
  const color = contextColor(percent)
  const w = Math.round((Math.min(100, percent) / 100) * 80)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 6" width="80" height="6">
    <rect width="80" height="6" rx="3" fill="${MUTED}" fill-opacity="0.3"/>
    <rect width="${w}" height="6" rx="3" fill="${color}"/></svg>`
}

const usd = (n: number) => `$${n.toFixed(2)}`

// Density, chosen as the fullest whose measured row fits the band's width, so the
// row drops details instead of running off the edge: 0 full; 1 no resets, short
// tokens; 2 compact turn/speed/cost, no context bar, tokens or agents; 3 turn cost and cache only,
// smaller icons; 4 no speed or limits.
const GAPS = [3, 2, 2, 1, 1] as const
// The desktop app's gaps are a cell's pixels wide, roomy already: the full row keeps 2.
const DESKTOP_GAPS = [2, 2, 2, 1, 1] as const
// The desktop app's cell, its code font's advance, in pixels: 147 columns over a
// 1235px band. Its band text is a little narrower than those cells.
const DESKTOP_CELL_PX = 8.4
const DESKTOP_TEXT = 0.92

// The last draw's width and each density's measured row, for `/turn-gauge width`.
let lastWidths: { columns: number; widths: number[]; tier: number } | null = null

// The band's labels for the windows it shows, in this order.
const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'wk' }
const LIMIT_WARN = 70
const LIMIT_ALERT = 90

// The limits are the account's, not the session's: kept in $.store too, so every
// session, new or resumed, draws them before its first answer.
const LIMITS_KEY = 'limits'

const saveLimits = async ($: EngineInterface, windows: readonly { kind: string; percentUsed: number; resetsAt?: string }[]) => {
  const list = windows
    .filter(w => w.kind in LIMIT_LABELS)
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt ?? null }))
  if (list.length === 0) return
  await update($, limits, () => list)
  await $.store.set(LIMITS_KEY, list)
  await recordPace($, list)
}

// The pace projection's readings, shared by every session through $.store: one
// window per kind, and the finished windows' scores.
const pace = atom({ plugin: 'turn-gauge', key: 'pace' } as const, { windows: {}, prev: {}, profile: null, dismissed: '' } as Pace)
const PACE_KEY = (kind: Kind) => `pace:${kind}`
const PACE_PREV_KEY = (kind: Kind) => `pace-prev:${kind}`
const PACE_HISTORY_KEY = 'pace-history'
const PACE_PROFILE_KEY = 'pace-profile'

const isWindow = (w: unknown): w is PaceWindow => typeof w === 'object' && w !== null && Array.isArray((w as PaceWindow).samples)
const isProfile = (p: unknown): p is Profile =>
  typeof p === 'object' && p !== null && Array.isArray((p as Profile).points) && (p as Profile).points.length === 168 && typeof (p as Profile).weeks === 'number'

const isKind = (kind: string): kind is Kind => (KINDS as readonly string[]).includes(kind)

const loadPace = async ($: EngineInterface) => {
  const windows: Pace['windows'] = {}
  const prev: Pace['prev'] = {}
  for (const kind of KINDS) {
    const w = await $.store.get(PACE_KEY(kind))
    if (isWindow(w)) windows[kind] = w
    const old = await $.store.get(PACE_PREV_KEY(kind))
    if (isWindow(old)) prev[kind] = old
  }
  const profile = await $.store.get(PACE_PROFILE_KEY)
  await update($, pace, p => ({ ...p, windows, prev, profile: isProfile(profile) ? profile : null }))
}

const contextOfPace = (p: Pace, kind: Kind, now: number) => ({
  prev: p.prev?.[kind] ?? null,
  profile: p.profile ?? null,
  offsetMinutes: localOffset(now),
})

// A live reading of each window: added to the shared record (re-read first, as
// another session may have written it), the projection noted at its marks, and a
// window that reset scored against where it ended.
const recordPace = async ($: EngineInterface, list: readonly Limit[]) => {
  const now = await $.clock.now()
  for (const l of list) {
    if (!isKind(l.kind) || l.resetsAt === null) continue
    const resetsAt = Date.parse(l.resetsAt)
    if (Number.isNaN(resetsAt)) continue
    const stored = await $.store.get(PACE_KEY(l.kind))
    const kept = isWindow(stored) ? stored : null
    const added = addSample(kept, l.kind, resetsAt, now, l.percentUsed)

    // A window that reset: scored, kept as the last window, and a finished week learned.
    if (added.finished !== null && kept !== null) {
      const history = ((await $.store.get(PACE_HISTORY_KEY)) as PaceRecord[] | undefined) ?? []
      const done = added.finished
      if (!history.some(r => r.kind === done.kind && r.resetsAt === done.resetsAt)) {
        await $.store.set(PACE_HISTORY_KEY, [...history, done].slice(-HISTORY_KEPT))
        await $.store.set(PACE_PREV_KEY(l.kind), kept)
        if (l.kind === 'seven_day') {
          const profile = await $.store.get(PACE_PROFILE_KEY)
          await $.store.set(PACE_PROFILE_KEY, learnWeek(isProfile(profile) ? profile : null, kept, localOffset(now)))
        }
      }
      await loadPace($)
    }

    const ctx = contextOfPace(await read($, pace), l.kind, now)
    const window = checkpoint(added.window, project(l.kind, added.window, now, ctx))
    if (added.isChanged || window !== added.window) await $.store.set(PACE_KEY(l.kind), window)
    await update($, pace, p => ({ ...p, windows: { ...p.windows, [l.kind]: window } }))
  }
}

// The machine's offset from UTC, in minutes, for the times the projection names.
const localOffset = (t: number) => -new Date(t).getTimezoneOffset()

const projectionsAt = (p: Pace, now: number) =>
  Object.fromEntries(KINDS.map(kind => [kind, project(kind, p.windows[kind] ?? null, now, contextOfPace(p, kind, now))])) as Record<Kind, Projection | null>

// A session's figures, saved after each answer under `session:<id>`, so a session the
// desktop app restarted or resumed draws its band at once instead of after its next answer.
type Snapshot = {
  turn: number
  total: number
  speed: number | null
  context: number
  expiresAt: number | null
  recentCosts?: number[]
  tokensIn?: number
  tokensOut?: number
  lastTurnTokens?: Tokens['last']
}
const SNAPSHOTS_KEPT = 50

// The desktop app's id outlives the process; the engine's is the fallback elsewhere.
const snapshotKey = async ($: EngineInterface) => {
  const host = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  return `session:${host !== undefined && HOST_SESSION.test(host) ? host : await $.session.id()}`
}

const saveSnapshot = async ($: EngineInterface) => {
  const s = await read($, stats)
  const { expiresAt } = await read($, cache)
  const tk = await read($, tokens)
  const key = await snapshotKey($)
  const snapshot: Snapshot = {
    turn: s.turn,
    total: s.total,
    speed: s.speed,
    context: s.context,
    expiresAt,
    recentCosts: s.recentCosts ?? [],
    tokensIn: tk.input,
    tokensOut: tk.output,
    lastTurnTokens: tk.last,
  }
  // Set again after a delete, the key moves last: the oldest sessions are pruned first.
  await $.store.delete(key)
  await $.store.set(key, snapshot)

  const saved = (await $.store.keys()).filter(k => k.startsWith('session:'))
  for (const old of saved.slice(0, Math.max(0, saved.length - SNAPSHOTS_KEPT))) await $.store.delete(old)
}

const restore = async ($: EngineInterface) => {
  await loadPace($)
  const usage = await $.session.usage()

  if (usage.rateLimits.length > 0) await saveLimits($, usage.rateLimits)
  else {
    const kept = (await $.store.get(LIMITS_KEY)) as Limit[] | undefined
    if (Array.isArray(kept) && kept.length > 0) await update($, limits, () => kept)
  }

  // A hot reload keeps $.state: only a fresh launch starts at turn 0.
  if ((await read($, stats)).turn !== 0) return
  const snapshot = (await $.store.get(await snapshotKey($))) as Snapshot | undefined
  if (snapshot === undefined) return

  const usd = usage.cost?.usd ?? 0
  // Where the engine's cost restarted with this launch, the saved total is the base.
  const costOffset = usd + 0.005 < snapshot.total ? snapshot.total : 0
  await update($, stats, s => ({
    ...s,
    turn: snapshot.turn,
    speed: snapshot.speed,
    context: snapshot.context,
    recentCosts: Array.isArray(snapshot.recentCosts) ? snapshot.recentCosts : [],
    total: costOffset + usd,
    costOffset,
  }))
  await update($, cache, c => (c.expiresAt === null ? { expiresAt: snapshot.expiresAt, secondsLeft: null } : c))
  // A relaunch starts a new cache: the next request's miss is expected.
  await update($, tokens, tk => ({
    ...tk,
    input: typeof snapshot.tokensIn === 'number' ? snapshot.tokensIn : tk.input,
    output: typeof snapshot.tokensOut === 'number' ? snapshot.tokensOut : tk.output,
    last: snapshot.lastTurnTokens ?? tk.last,
    lastCause: 'fresh',
  }))
}

const limitColor = (percent: number) =>
  percent >= LIMIT_ALERT ? ALERT : percent >= LIMIT_WARN ? WARN : undefined

// Time until a window resets: 3d, 14h, 2h10m, 45m.
const resetIn = (resetsAt: string | null, now: number) => {
  if (resetsAt === null) return null
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60_000))
  if (Number.isNaN(minutes)) return null
  if (minutes >= 48 * 60) return `${Math.round(minutes / 1440)}d`
  if (minutes >= 10 * 60) return `${Math.round(minutes / 60)}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
  return `${minutes}m`
}

// `isAgent`: a subagent's request or end. Between turns, what a background agent spends
// still belongs to the turn that started it, so that turn's place in the recent costs grows too.
const refresh = async ($: EngineInterface, isAgent = false) => {
  const { cost, context, rateLimits } = await $.session.usage()
  await saveLimits($, rateLimits)
  const usd = cost?.usd ?? 0
  const isBetweenTurns = isAgent && !(await read($, isBusy))
  await update($, stats, s => {
    const total = (s.costOffset ?? 0) + usd
    const turnCost = total - s.costAtStart
    const recent = s.recentCosts ?? []
    const recentCosts = isBetweenTurns && recent.length > 0 ? [...recent.slice(0, -1), turnCost] : s.recentCosts
    return { ...s, total, turnCost, recentCosts, context: context.percent ?? s.context }
  })
  await sampleAgents($)
}

// Built by notifier/build.sh (macOS): posts the warning under Claude's icon.
const NOTIFIER = 'notifier/Turn Gauge.app/Contents/MacOS/turn-gauge-notifier'
// The desktop app's id for a local Code session, as its claude:// links take it.
const HOST_SESSION = /^local_[A-Za-z0-9-]{1,64}$/

// This session as the desktop app knows it: its id and the title in its sidebar.
// Null outside the desktop app; the title null when its record cannot be read.
const desktopSession = async ($: EngineInterface) => {
  const id = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  if (id === undefined || !HOST_SESSION.test(id)) return null

  const home = await $.env.get('HOME')
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const org = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
  const record = `${home}/Library/Application Support/Claude/claude-code-sessions/${account}/${org}/${id}.json`
  const title = await $.fs.read(record).then(
    text => (JSON.parse(text) as { title?: unknown }).title,
    () => undefined,
  )

  return { id, title: typeof title === 'string' && title.trim() !== '' ? title.trim() : null }
}

// The notifier's system notification, titled with the project and the session, which
// opens this session when clicked. Without the notifier (not built, not macOS, or
// notifications not allowed), Claude Code's own notification, which also reaches
// the phone over Remote Control; it is skipped while the person is at this session,
// and then a toast says it instead.
// The cache countdown's timer. The band shows whole minutes, so it wakes only at the
// next minute the countdown changes; the cache notifications and the expiry fall on
// those minutes too. Nothing counting, no wake.
let wake: Timer | null = null

const tick = async ($: EngineInterface): Promise<void> => {
  wake?.cancel()
  wake = null
  const now = await $.clock.now()
  const next: number[] = []

  const expiresAt = (await read($, cache)).expiresAt ?? ((await read($, cacheModExpiresAt)) as number | null)
  if (expiresAt !== null) {
    const left = Math.max(0, expiresAt - now) / 1000
    // Minutes rounded up, stored that way: it changes, and redraws, once a minute.
    const shown = Math.ceil(left / 60)
    if (shown * 60 !== (await read($, cache)).secondsLeft) {
      await update($, cache, c => ({ expiresAt: c.expiresAt ?? expiresAt, secondsLeft: shown * 60 }))
    }
    if (left > 0) next.push(expiresAt - (shown - 1) * 60_000)
    await notifyIfDue($, left)
  }

  // A little past the minute, so the wake lands after the change, not just before it.
  if (next.length > 0) wake = $.clock.after(Math.max(0, Math.min(...next) - now) + 20, () => void tick($))
}

const notifyIfDue = async ($: EngineInterface, left: number) => {
  const due = CACHE_NOTIFY_MINUTES.filter(m => left > 0 && left <= m * 60)
  if (due.length === 0 || (await read($, isBusy))) return

  const minutes = Math.min(...due)
  const last = await read($, warned)
  if (last !== 0 && last <= minutes) return

  await update($, warned, () => minutes)
  await notifyCacheExpiry($, Math.ceil(left / 60))
}

const notifyCacheExpiry = async ($: EngineInterface, minutes: number) => {
  const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? 'session'
  const cost = resumeCost(spendInputs(await read($, spend)))
  const message = `Prompt cache expires in ${minutes} min${cost !== null && cost >= 0.1 ? `; then the next message costs ≈ ${formatUsd(cost)}` : ''}`

  const notifier = `${$.plugin.root}/${NOTIFIER}`
  if (await $.fs.exists(notifier)) {
    const session = await desktopSession($)
    const argv = [
      notifier,
      '-title',
      session?.title ? `${project} — ${session.title}` : project,
      '-message',
      message,
      '-group',
      `turn-gauge-${session?.id ?? (await $.session.id())}`,
      ...(session ? ['-open', `claude://code/continue?session=${session.id}`] : []),
    ]
    // The first run waits while macOS asks whether to allow its notifications.
    const ran = await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => null)
    if (ran?.exitCode === 0) return
  }

  const text = `${project}: ${message}`
  const sent = await $.tool
    .call({ tool: 'PushNotification', message: text, status: 'proactive' })
    .catch(() => null)
  const isDelivered =
    sent !== null &&
    sent.deny === undefined &&
    sent.isError !== true &&
    (sent.result.pushSent === true || sent.result.localSent === true)

  if (!isDelivered) $.ui.toast(`⏳ ${text}`, { timeoutMs: 30000 })
}

// One response's usage: priced for calibration; on the main loop, the context it
// carried, a fresh session's baseline, and a compaction's summary.
const recordUsage = async ($: EngineInterface, usage: TurnUsage, isMain: boolean) => {
  const price = predictUsd(usage.model, usage)
  if (!isMain) return update($, spend, sp => ({ ...sp, predicted: sp.predicted + price }))

  const context = contextOf(usage)
  const before = await read($, spend)

  let baseline = before.baseline
  let isBaselineMeasured = before.isBaselineMeasured
  if (before.isFresh && before.steps === 0) {
    const samples = await pushSample($, BASELINE_KEY(await $.session.cwd()), context)
    baseline = Math.min(...samples)
    isBaselineMeasured = true
  }

  let summary = before.summary
  if (before.isCompactPending && baseline !== null && context > baseline) {
    summary = median(await pushSample($, SUMMARIES_KEY, context - baseline))
  }

  // Another model prices differently: calibration starts over.
  const isNewModel = before.model !== null && before.model !== usage.model
  await update($, spend, sp => ({
    ...sp,
    model: usage.model,
    context,
    baseline,
    isBaselineMeasured,
    summary,
    steps: sp.steps + 1,
    predicted: sp.predicted + price,
    isFresh: false,
    isCompactPending: false,
    ...(isNewModel ? { scale: null, calibPredicted: 0, calibObserved: 0 } : {}),
  }))
}

// At a main turn's end: the engine's cost against list price, the requests a turn
// makes, and B from /context's breakdown while no fresh session has measured it.
const settleSpend = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  const usd = usage.cost?.usd ?? 0
  const sp = await read($, spend)
  const calibPredicted = sp.calibPredicted + sp.predicted
  const calibObserved = sp.calibObserved + Math.max(0, usd - sp.usdAtTurnStart)
  const scale = calibPredicted >= 0.02 ? Math.min(4, Math.max(0.25, calibObserved / calibPredicted)) : sp.scale
  const recentSteps = sp.steps === 0 ? (sp.recentSteps ?? []) : [...(sp.recentSteps ?? []), sp.steps].slice(-RECENT_TURNS)

  let baseline = sp.baseline
  if (!sp.isBaselineMeasured) {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    baseline = context.breakdown ? baselineFromBreakdown(context.breakdown.categories) : null
  }
  await update($, spend, s => ({ ...s, calibPredicted, calibObserved, scale, recentSteps, baseline }))
}

// Where the last `turns` turns begin: the index of the user message that opens the
// earliest of them, -1 when the conversation has no earlier message to summarize.
// A turn is a prompt the model answered: slash commands run in the terminal
// (/plugin, /reload-plugins, …) leave user messages that no reply follows, and
// the messages run together before a reply (prompt, reminders) open one turn.
export const tailStart = (messages: readonly SessionMessage[], turns: number) => {
  const isOpener = (m: SessionMessage) => m.role === 'user' && (m.toolResults?.length ?? 0) === 0
  let seen = 0
  let isAnswered = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant') {
      isAnswered = true
      continue
    }
    if (!isOpener(m) || !isAnswered) continue
    while (i > 0 && isOpener(messages[i - 1]!)) i--
    if (++seen === turns) return i > 0 ? i : -1
    isAnswered = false
  }
  return -1
}

// A compaction that keeps the last `turns` turns: `summarize` gets the older
// messages, and the kept ones follow its summary as they were.
export const compactWithTail = async (
  messages: readonly SessionMessage[],
  turns: number,
  summarize: (older: SessionMessage[]) => Promise<SessionCompactResult>,
): Promise<SessionCompactResult> => {
  const cut = tailStart(messages, turns)
  if (cut === -1) return { skip: `Nothing before the last ${turns} turn${turns === 1 ? '' : 's'} to summarize.` }
  const result = await summarize(messages.slice(0, cut))
  if (result.messages === undefined) return result
  const { tokensAfter: _, ...rest } = result
  return { ...rest, messages: [...result.messages, ...messages.slice(cut)] }
}

// The compaction this mod started, and how many turns it keeps. Only that one call
// is cut: /compact (`manual`), auto-compaction (`auto`), ahead-of-time compaction
// (`precompute`) and other mods' calls pass through as Claude Code makes them.
let keepTailTurns: number | null = null

const compactKeepingTail = async ($: EngineInterface, turns: number): Promise<SessionCompactResult> => {
  if (keepTailTurns !== null) return { skip: 'A compaction is already running.' }
  keepTailTurns = turns
  try {
    return await $.session.compact({
      instructions: `The last ${turns} turn${turns === 1 ? ' is' : 's are'} kept word for word after this summary: summarize only what comes before.`,
    })
  } catch (error) {
    return { skip: error instanceof Error ? error.message : String(error) }
  } finally {
    keepTailTurns = null
  }
}

// The band's background from the setting: hex, a color name or a theme key; anything
// else, empty included, leaves the terminal's own.
export const bandBackground = (value: unknown) => {
  const v = typeof value === 'string' ? value.trim() : ''
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) || /^[a-z][a-z0-9]{1,31}$/i.test(v) ? v : undefined
}

// The terminal draws no images: its icons are emoji, or glyphs colored like the band.
const TERMINAL_ICONS = {
  emoji: { speed: '⚡', cost: '💰', cache: '⏳' },
  glyphs: { speed: '⚡\uFE0E', cost: '$', cache: '⧗' },
} as const

// The terminal's context bar: cells filled as the context fills.
const BAR_CELLS = 10
export const terminalContextBar = (percent: number) => {
  const p = Math.min(100, Math.max(0, percent))
  const filled = Math.round((p / 100) * BAR_CELLS)
  return {
    filled: '█'.repeat(filled),
    empty: '░'.repeat(BAR_CELLS - filled),
    color: contextColor(p),
  }
}

// Brings back every warning the person dismissed: the overhead, the turn's cache
// miss and output, and the pace heads-up.
const restoreWarnings = async ($: EngineInterface) => {
  await update($, spend, sp => ({ ...sp, dismissedAt: null }))
  await update($, tokens, t => ({ ...t, dismissedTurn: -1 }))
  await update($, pace, p => ({ ...p, dismissed: '' }))
}

export const register: Register = (on, options) => {
  const keepTurns = Math.min(20, Math.max(1, Math.round(Number(options.keepTurns ?? 3)) || 3))
  const background = bandBackground(options.background)
  const glyphs = TERMINAL_ICONS[options.terminalIcons === 'glyphs' ? 'glyphs' : 'emoji']

  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const turns = isMain && e.trigger === 'plugin' ? keepTailTurns : null
    const result =
      turns === null ? await next(e) : await compactWithTail(e.messages, turns, older => next({ ...e, messages: older }))

    // A plain compaction's summary is measured on the next request, for the /compact estimate.
    // The context the last request carried is gone: no warning until the next one says what is left.
    if (result.messages !== undefined && isMain && e.trigger !== 'precompute') {
      await update($, spend, sp => ({ ...sp, context: null, isCompactPending: turns === null, dismissedAt: null }))
      await update($, tokens, tk => ({ ...tk, prevContext: null, cause: tk.cause ?? 'compacted' }))
    }
    return result
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const wasRunning = (await read($, stats)).turn !== 0
    await restore($)

    // No turn kept and none restored: this session starts from nothing, so its
    // first request measures what a fresh session in this project carries.
    const isFresh = !wasRunning && (await read($, stats)).turn === 0
    const cwd = await $.session.cwd()
    const baselines = (await $.store.get(BASELINE_KEY(cwd))) as number[] | undefined
    const summaries = (await $.store.get(SUMMARIES_KEY)) as number[] | undefined
    const measured = Array.isArray(baselines) && baselines.length > 0 ? Math.min(...baselines) : null
    await update($, spend, sp => ({
      ...sp,
      isFresh: wasRunning ? sp.isFresh : isFresh,
      baseline: measured ?? sp.baseline,
      isBaselineMeasured: measured !== null || sp.isBaselineMeasured,
      summary: Array.isArray(summaries) ? median(summaries) : sp.summary,
    }))

    // A load (a reload too) starts with every warning showing again.
    await restoreWarnings($)

    await $.command.register({
      name: 'turn-gauge',
      description: 'Show or hide the turn gauge band; `pace` projects the plan windows; `compact [turns]` compacts keeping recent turns; `demo <minutes>` previews the cache warning',
    })

    await tick($)

    return result
  })

  on('command.run', { command: 'turn-gauge' }, async ($, e) => {
    // `/turn-gauge demo <minutes>` fakes the cache deadline to preview the warnings;
    // the next answer resets it.
    const demo = e.args.trim().match(/^demo\s+(\d+(?:\.\d+)?)$/)
    if (demo) {
      const seconds = Math.round(Number(demo[1]) * 60)
      const now = await $.clock.now()
      await update($, cache, () => ({ expiresAt: now + seconds * 1000, secondsLeft: seconds }))
      await update($, warned, () => 0)
      await update($, isHidden, () => false)
      await tick($)

      return { text: `Cache demo: ${demo[1]} min left until the next answer resets it.` }
    }

    // `/turn-gauge compact [turns]`: summarize all but the last turns, kept word for word.
    const compact = e.args.trim().match(/^compact(?:\s+(\d+))?$/)
    if (compact) {
      const turns = compact[1] === undefined ? keepTurns : Math.max(1, Number(compact[1]))
      // A command holds the turn it answers: the compaction starts once it has returned.
      $.clock.after(0, async () => {
        const result = await compactKeepingTail($, turns)
        $.ui.toast(
          result.messages === undefined
            ? `Not compacted: ${result.skip}`
            : `Compacted: a summary, then the last ${turns} turn${turns === 1 ? '' : 's'} word for word.`,
        )
      })
      return { text: `Compacting, keeping the last ${turns} turn${turns === 1 ? '' : 's'}…` }
    }

    // `/turn-gauge pace`: where each window ends at this pace, and how well past projections did.
    if (e.args.trim() === 'pace') {
      await loadPace($)
      const now = await $.clock.now()
      const projections = projectionsAt(await read($, pace), now)
      const history = ((await $.store.get(PACE_HISTORY_KEY)) as PaceRecord[] | undefined) ?? []
      const offset = localOffset(now)
      return {
        text: [
          ...KINDS.map(kind => describe(projections[kind], kind, now, offset)),
          '',
          ...KINDS.map(kind => describeAccuracy(history, kind)),
        ].join('\n'),
      }
    }

    if (e.args.trim() === 'width') {
      const w = lastWidths
      return {
        text: w === null ? 'Band not drawn yet.' : `Band: ${w.columns} columns, tier ${w.tier}; row widths by tier: ${w.widths.join(', ')}.`,
      }
    }

    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)
    if (!hidden) {
      // Showing the band again brings the dismissed warnings back with it.
      await restoreWarnings($)
    }

    return { text: hidden ? 'Turn gauge hidden.' : 'Turn gauge shown.' }
  })

  // A window moved a whole point, between turns too.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await saveLimits($, e.rateLimits)
    return next(e)
  })

  // The main loop's turns only: a subagent's run within one is part of its cost,
  // not a turn of its own, and only the main loop's turn.complete ends the busy spell.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const usd = (await $.session.usage()).cost?.usd ?? 0
    await update($, spend, sp => ({ ...sp, steps: 0, predicted: 0, usdAtTurnStart: usd }))
    // A cache already past its lifetime makes this turn's re-write expected.
    const { expiresAt } = await read($, cache)
    const isExpired = expiresAt !== null && expiresAt <= (await $.clock.now())
    await update($, tokens, tk => ({
      ...tk,
      turn: NO_TOKENS,
      cause: isExpired ? 'expired' : tk.prevContext === null ? 'fresh' : null,
    }))
    await update($, stats, s => {
      const total = (s.costOffset ?? 0) + usd
      return { ...s, turn: s.turn + 1, costAtStart: total, total }
    })
    await startAgentSpend($)
    await update($, isBusy, () => true)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      for await (const chunk of next(e)) {
        if (chunk.kind === 'stop' && chunk.usage !== null) {
          await recordTokens($, chunk.usage, false)
          await recordUsage($, chunk.usage, false)
          await refresh($, true)
        }
        yield chunk
      }
      return
    }

    await update($, effort, () => (e.effort === undefined ? null : String(e.effort)))

    // Measured from the response's first item (its envelope, message_start), so
    // time-to-first-token is excluded but thinking that streams hidden or in one
    // late burst is still timed: output_tokens counts it.
    let startedAt: number | null = null

    for await (const chunk of next(e)) {
      if (startedAt === null) {
        startedAt = await $.clock.now()
      }

      if (chunk.kind === 'stop' && chunk.usage !== null) {
        await recordTokens($, chunk.usage, true)
        await recordUsage($, chunk.usage, true)
        const tokens = chunk.usage.output_tokens
        const seconds = ((await $.clock.now()) - startedAt) / 1000
        const speed = tokens / seconds
        if (tokens >= MIN_TOKENS && seconds >= MIN_SECONDS && speed <= MAX_SPEED) {
          await update($, stats, s => ({ ...s, speed: Math.round(speed) }))
        }
      }

      yield chunk
    }

    await refresh($)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($, e.agentId !== undefined)

    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, cache, () => ({ expiresAt: now + CACHE_TTL_MS, secondsLeft: CACHE_TTL_MS / 1000 }))
      await update($, isBusy, () => false)
      await update($, warned, () => 0)
      await update($, tokens, tk => ({ ...tk, last: tk.turn, lastCause: tk.cause }))
      await tick($)
      await update($, stats, st =>
        st.turnCost === null ? st : { ...st, recentCosts: [...(st.recentCosts ?? []), st.turnCost].slice(-RECENT_TURNS) },
      )
      await settleSpend($)
      await saveSnapshot($)
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, stats)
    const saved = await read($, limits)
    // Before a session's first answer the band still draws when the plan's limits are known.
    if (e.props.hasSurvey || (s.turn === 0 && saved.length === 0) || (await read($, isHidden))) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // The terminal hands back an Svg too but draws it empty: its icons are text.
    const isTerminal = e.surface === 'terminal'
    const Svg = !isTerminal && 'Svg' in ui ? ui.Svg : null
    const speed = s.speed === null ? '—' : `${s.speed} tok/s`
    const turnCost = s.turnCost === null ? '—' : usd(s.turnCost)
    // The part of the turn's cost its subagents spent; under half a cent it reads <$0.01.
    const agentsCost = s.turnCost !== null && (s.agentsCost ?? 0) > 0 ? s.agentsCost! : null

    const { secondsLeft } = await read($, cache)
    const level =
      e.props.isWorking || secondsLeft === null
        ? null
        : secondsLeft <= CACHE_ALERT_S
          ? ALERT
          : secondsLeft <= CACHE_WARN_S
            ? WARN
            : null
    const cacheColor = level ?? CACHE
    const cacheText =
      e.props.isWorking ? '…'
      : secondsLeft === null ? '—'
      : secondsLeft === 0 ? 'expired'
      : `${Math.ceil(secondsLeft / 60)}m`

    const modelName = shortModel(await $.session.model())
    const effortLevel = await read($, effort)
    const sp = await read($, spend)
    const perTurn = costPerTurn(s.recentCosts ?? [])

    const now = await $.clock.now()
    const paceState = await read($, pace)
    const projections = projectionsAt(paceState, now)
    const offset = localOffset(now)
    // The window that runs out first, unless its heads-up was dismissed this window.
    const runOut = KINDS.map(kind => projections[kind])
      .filter((p): p is Projection => p !== null && p.runOutAt !== null && paceState.dismissed !== `${p.kind}:${p.resetsAt}`)
      .sort((a, b) => a.runOutAt! - b.runOutAt!)[0]
    const paceWarning = runOutWarning(runOut ?? null, now, offset)

    const tk = await read($, tokens)
    const rate = tk.last === null ? null : hitRate(tk.last)

    // Shown while idle, when the next message is still the person's to decide: an
    // expired cache first, then what the last turn did, then running out of a plan
    // window, then the steady overhead. Two side by side when both fit.
    const isTurnDismissed = tk.dismissedTurn === s.turn
    const missWarning = cacheMissWarning(spendInputs(sp), tk.last, tk.lastCause)
    const isOverheadDismissed = sp.dismissedAt !== null && (sp.context ?? 0) < sp.dismissedAt + DISMISS_GROWTH
    type Warning = SpendWarning | { kind: 'pace'; text: string }
    const ranked: (Warning | null)[] = e.props.isWorking
      ? []
      : secondsLeft === 0
        ? [expiredWarning(spendInputs(sp)), paceWarning]
        : [
            isTurnDismissed ? null : missWarning,
            isTurnDismissed ? null : outputWarning(spendInputs(sp), tk.last),
            paceWarning,
            isOverheadDismissed ? null : overheadWarning(spendInputs(sp, s.recentCosts ?? [])),
          ]
    const candidates = ranked.filter((w): w is Warning => w !== null)
    const rateColor = rate === null ? undefined : missWarning !== null ? ALERT : rate < RATE_WARN ? WARN : undefined
    // A window whose reset has passed since it was saved stands at 0 until the next reading.
    const windows = Object.keys(LIMIT_LABELS).flatMap(kind => {
      const w = saved.find(l => l.kind === kind)
      if (w === undefined) return []
      return w.resetsAt !== null && Date.parse(w.resetsAt) <= now ? [{ ...w, percentUsed: 0, resetsAt: null }] : [w]
    })

    // The row as segments of parts, at a density: measured to choose the density
    // that fits, then drawn. `tier` 0 is the fullest.
    type Part =
      | { kind: 'text'; text: string; bold?: boolean; dim?: boolean; color?: string }
      | { kind: 'icon'; svg: string; alt: string; glyph: string | null; color?: string }
      | { kind: 'bar'; percent: number }
    type Segment = { key: string; parts: Part[] }
    const T = (text: string, style: Omit<Extract<Part, { kind: 'text' }>, 'kind' | 'text'> = {}): Part => ({ kind: 'text', text, ...style })
    const B = (text: string, color?: string) => T(text, { bold: true, color })
    const D = (text: string) => T(text, { dim: true })

    const segmentsFor = (tier: number): Segment[] => {
      const segs: Segment[] = []
      if (tier <= 2) segs.push({ key: 'turn', parts: [D(tier <= 1 ? 'Turn' : '#'), B(String(s.turn))] })
      if (tier <= 3) {
        segs.push({
          key: 'speed',
          parts: [
            { kind: 'icon', svg: SPEED_ICON, alt: 'speed', glyph: glyphs.speed, color: SPEED },
            B(tier <= 1 || s.speed === null ? speed : `${s.speed}/s`),
          ],
        })
      }
      const cost: Part[] = [{ kind: 'icon', svg: MONEY_ICON, alt: 'cost', glyph: glyphs.cost, color: MONEY }, B(turnCost, MONEY)]
      if (tier <= 1 && agentsCost !== null) cost.push(D(`(agents ${agentsCost < 0.005 ? '<$0.01' : usd(agentsCost)})`))
      if (perTurn !== null) cost.push(D(tier <= 1 ? '· med' : '·'), B(usd(perTurn.median)), D(tier <= 1 ? '· avg' : '/'), B(usd(perTurn.mean)))
      if (tier <= 2) cost.push(D('|'), B(usd(s.total)))
      segs.push({ key: 'cost', parts: cost })
      const cachePart: Part[] = [{ kind: 'icon', svg: cacheIcon(cacheColor), alt: 'cache', glyph: glyphs.cache, color: cacheColor }, B(cacheText, level ?? undefined)]
      if (rate !== null && tier <= 2) cachePart.push(D('·'), B(`${Math.round(rate * 100)}%`, rateColor))
      segs.push({ key: 'cache', parts: cachePart })
      if (tier <= 1 && tk.input + tk.output > 0) {
        segs.push({
          key: 'tokens',
          parts: [
            D('Σ'),
            B(tier === 0 ? `${formatTokens(tk.input)} in` : formatTokens(tk.input)),
            D(tier === 0 ? '·' : '/'),
            B(tier === 0 ? `${formatTokens(tk.output)} out` : formatTokens(tk.output)),
          ],
        })
      }
      if (tier <= 3) {
        for (const w of windows) {
          const reset = tier === 0 ? resetIn(w.resetsAt, now) : null
          segs.push({
            key: w.kind,
            parts: [D(LIMIT_LABELS[w.kind]!), B(`${Math.round(w.percentUsed)}%`, limitColor(w.percentUsed)), ...(reset !== null ? [D(`↻${reset}`)] : [])],
          })
        }
      }
      segs.push({
        key: 'context',
        parts: [
          { kind: 'icon', svg: contextIcon(s.context), alt: 'context', glyph: null },
          ...(tier <= 1 ? [{ kind: 'bar', percent: s.context } as const] : []),
          B(`${s.context}%`),
        ],
      })
      return segs
    }

    // Widths in the surface's cells. The terminal's are exact but for emoji (two cells).
    // The desktop app counts cells in its code font's advance but draws the band in its
    // own font with pixel icons: its text is scaled and its icons are their pixels.
    // Fractions add up across the row; only the total is rounded.
    const iconSize = (tier: number) => (tier >= 3 ? 18 : 22)
    const gaps = Svg ? DESKTOP_GAPS : GAPS
    const partWidth = (p: Part, tier: number) =>
      p.kind === 'text'
        ? Svg ? p.text.length * DESKTOP_TEXT : [...p.text].length
        : p.kind === 'bar'
          ? Svg ? 80 / DESKTOP_CELL_PX : BAR_CELLS
          : Svg ? iconSize(tier) / DESKTOP_CELL_PX
          : p.glyph === null ? 0
          : options.terminalIcons === 'glyphs' ? 1 : 2
    const rowWidth = (tier: number) => {
      const segs = segmentsFor(tier)
      const inner = segs.map(seg => {
        const ws = seg.parts.map(p => partWidth(p, tier)).filter(w => w > 0)
        return ws.reduce((a, b) => a + b, 0) + Math.max(0, ws.length - 1)
      })
      // The padding; a frame's sides while framed; the hide button with its gap when
      // it sits on this row, as it does without a model or warning row below.
      const isHideHere = tier >= 3 && candidates.length === 0
      return Math.ceil(
        inner.reduce((a, b) => a + b, 0) + gaps[tier]! * (segs.length - 1) + 2 + (level !== null ? 2 : 0) + (isHideHere ? 3 : 0),
      )
    }
    const tier = [0, 1, 2, 3].find(t => rowWidth(t) <= e.props.bodyColumns) ?? 4
    lastWidths = { columns: e.props.bodyColumns, widths: [0, 1, 2, 3, 4].map(rowWidth), tier }
    const icon = iconSize(tier)

    const drawPart = (p: Part, i: number) =>
      p.kind === 'text' ? (
        <Text key={String(i)} bold={p.bold} dimColor={p.dim} color={p.color}>{p.text}</Text>
      ) : p.kind === 'bar' ? (
        Svg ? (
          <Svg key="context-bar" source={contextBar(p.percent)} alt={`context ${p.percent}%`} width={80} height={6} />
        ) : (
          <Box key="context-bar" flexDirection="row" flexShrink={0}>
            <Text color={terminalContextBar(p.percent).color}>{terminalContextBar(p.percent).filled}</Text>
            <Text color={terminalContextBar(p.percent).color}>{terminalContextBar(p.percent).empty}</Text>
          </Box>
        )
      ) : Svg ? (
        <Svg key={String(i)} source={p.svg} alt={p.alt} width={icon} height={icon} />
      ) : p.glyph !== null ? (
        <Text key={String(i)} color={p.color}>{p.glyph}</Text>
      ) : null

    // A warning's width: its text, its buttons with their gaps.
    const compactLabel = `compact, keep ${keepTurns}`
    const widthOf = (w: Warning) => w.text.length + 2 + (w.kind === 'overhead' ? compactLabel.length + 5 : 0)
    // Padding and the frame's sides; the separator between two.
    // The model and effort sit at the right of the second row, before the warnings' room.
    const modelBox =
      tier <= 2 ? (
        <Box key="model" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          <Text bold wrap="truncate-end">{modelName}</Text>
          {tier <= 1 && effortLevel !== null ? <Text dimColor>{`· ${effortLevel}`}</Text> : null}
        </Box>
      ) : null
    const modelWidth = tier <= 2 ? modelName.length + (tier <= 1 && effortLevel !== null ? effortLevel.length + 3 : 0) + 1 : 0
    const room = e.props.bodyColumns - 4 - modelWidth
    const warnings =
      candidates.length >= 2 && widthOf(candidates[0]!) + 3 + widthOf(candidates[1]!) <= room
        ? candidates.slice(0, 2)
        : candidates.slice(0, 1)
    const warning = warnings[0] ?? null
    // The frame takes two rows: dropped when the warning row would not fit with it.
    const hasSecondRow = warning !== null || modelBox !== null
    // At the right end of the second row, after the effort level; on the first when there is none.
    const hideButton = <Button key="hide" label="×" role="dismiss" plain dimColor onPress={() => update($, isHidden, () => true)} />
    const framed = level !== null && e.props.maxRows >= (hasSecondRow ? 4 : 3)

    const row = (
      <Box flexDirection="row" alignItems="center" columnGap={gaps[tier]} flexWrap="nowrap" overflow="hidden">
        {segmentsFor(tier).flatMap(seg => [
          ...(seg.key === 'context' ? [<Box key="spacer" flexGrow={1} flexShrink={1} />] : []),
          <Box key={seg.key} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {seg.parts.map(drawPart)}
          </Box>,
        ])}
        {hasSecondRow ? null : hideButton}
      </Box>
    )

    return (
      <Box
        key="band"
        flexDirection="column"
        paddingX={1}
        {...(background !== undefined ? { backgroundColor: background } : {})}
        {...(framed ? { borderStyle: 'round', borderColor: level } : {})}
      >
        {row}
        {hasSecondRow ? (
          <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="nowrap" overflow="hidden">
            {warnings.flatMap((w, i) => {
              const isLast = i === warnings.length - 1
              // Both turn warnings go with one dismissal: one ×, on the later.
              const hasTurnDismiss =
                (w.kind === 'cache-miss' || w.kind === 'output') &&
                !warnings.slice(i + 1).some(o => o.kind === 'cache-miss' || o.kind === 'output')
              // The warning's own × sits at its left, away from the band's hide ×.
              return [
                ...(i > 0 ? [<Text key={`sep-${w.kind}`} dimColor>│</Text>] : []),
                ...(w.kind === 'overhead'
                  ? [
                      <Button
                        key="dismiss-spend"
                        label="×"
                        role="dismiss"
                        plain
                        dimColor
                        onPress={() => update($, spend, s => ({ ...s, dismissedAt: s.context }))}
                      />,
                    ]
                  : []),
                ...(w.kind === 'pace' && runOut !== undefined
                  ? [
                      <Button
                        key="dismiss-pace"
                        label="×"
                        role="dismiss"
                        plain
                        dimColor
                        onPress={() => update($, pace, p => ({ ...p, dismissed: `${runOut.kind}:${runOut.resetsAt}` }))}
                      />,
                    ]
                  : []),
                ...(hasTurnDismiss
                  ? [
                      <Button
                        key="dismiss-turn"
                        label="×"
                        role="dismiss"
                        plain
                        dimColor
                        onPress={() => update($, tokens, t => ({ ...t, dismissedTurn: s.turn }))}
                      />,
                    ]
                  : []),
                <Text key={`warn-${w.kind}`} color={WARN} wrap="truncate-end">{w.text}</Text>,
                ...(isLast ? [<Box key="spacer" flexGrow={1} flexShrink={1} />] : []),
                ...(w.kind === 'overhead'
                  ? [
                      <Button
                        key="compact"
                        label={compactLabel}
                        onPress={async () => {
                          const result = await compactKeepingTail($, keepTurns)
                          if (result.messages === undefined) $.ui.toast(`Not compacted: ${result.skip}`)
                        }}
                      />,
                    ]
                  : []),
              ]
            })}
            {warning === null ? <Box key="spacer" flexGrow={1} flexShrink={1} /> : null}
            {modelBox}
            {hideButton}
          </Box>
        ) : null}
      </Box>
    )
  })
}
