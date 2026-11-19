import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionCompactResult, SessionMessage, TurnUsage } from 'claude-code'

import type { Cache, Git, Limit, Spend, Stats, TurnClock } from '../types'
import {
  baselineFromBreakdown,
  contextOf,
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

const stats = atom({ plugin: 'session-band', key: 'stats' } as const, {
  turn: 0,
  speed: null,
  turnCost: null,
  total: 0,
  context: 0,
  costAtStart: 0,
} as Stats)

const cache = atom({ plugin: 'session-band', key: 'cache' } as const, {
  expiresAt: null,
  secondsLeft: null,
} as Cache)

// The plan's rate-limit windows as the last response reported them; empty off a subscription.
const limits = atom({ plugin: 'session-band', key: 'limits' } as const, [] as Limit[])

// Closed with ×: stays hidden for the rest of the session.
const isHidden = atom({ plugin: 'session-band', key: 'isHidden' } as const, false)

// A turn is running: the cache stays warm, so no countdown warnings.
const isBusy = atom({ plugin: 'session-band', key: 'isBusy' } as const, false)

// The smallest CACHE_NOTIFY_MINUTES already announced since the last answer; 0 none.
const warned = atom({ plugin: 'session-band', key: 'warned' } as const, 0)

// The effort level the main loop's last request carried; null where none was sent.
const effort = atom({ plugin: 'session-band', key: 'effort' } as const, null as string | null)

// The main loop's running turn: when it began and the seconds since, ticked each second.
const turnClock = atom({ plugin: 'session-band', key: 'turnClock' } as const, { startedAt: null, seconds: 0 } as TurnClock)

// The working tree's branch and whether it has changes; null outside a repository.
const git = atom({ plugin: 'session-band', key: 'git' } as const, null as Git | null)

// How often git is read between turns, for changes made outside the session.
const GIT_POLL_MS = 15_000
const BRANCH_MAX = 24

// `git status --porcelain=v2 --branch`: the head line names the branch, any line
// that is not a header is a change. A detached head shows its short commit.
const parseGit = (stdout: string): Git | null => {
  const lines = stdout.split('\n').filter(Boolean)
  const head = lines.find(l => l.startsWith('# branch.head '))?.slice(14)
  if (head === undefined) return null
  const oid = lines.find(l => l.startsWith('# branch.oid '))?.slice(13)
  const branch = head === '(detached)' ? (oid?.slice(0, 7) ?? 'detached') : head
  return { branch, isDirty: lines.some(l => !l.startsWith('#')) }
}

// `--no-optional-locks` keeps status from taking index.lock, so it never races
// the person's or Claude's own git commands; `core.fsmonitor=false` keeps a
// repository's own config from running a command every poll. Rewritten only when it changed.
const refreshGit = async ($: EngineInterface) => {
  const result = await $.process
    .run(['git', '-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], {
      timeoutMs: 5000,
    })
    .catch(() => null)
  const next = result === null || result.exitCode !== 0 ? null : parseGit(result.stdout)
  const current = await read($, git)
  if (current?.branch !== next?.branch || current?.isDirty !== next?.isDirty) await update($, git, () => next)
}

const elapsed = (seconds: number) => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(seconds % 60)}` : `${m}:${pad(seconds % 60)}`
}

const branchLabel = ({ branch, isDirty }: Git) =>
  `${branch.length > BRANCH_MAX ? `${branch.slice(0, BRANCH_MAX - 1)}…` : branch}${isDirty ? '*' : ''}`

// What the long context costs against starting over: the measured inputs of the
// spend warnings, and the running sums that calibrate list prices to the engine's cost.
const spend = atom({ plugin: 'session-band', key: 'spend' } as const, {
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

// Kept across sessions: a fresh session's first request per project, and compaction summaries.
const BASELINE_KEY = (cwd: string) => `baseline:${cwd}`
const SUMMARIES_KEY = 'summaries'
const SAMPLES_KEPT = 5
// The overhead warning, dismissed, returns once the context grew this much more.
const DISMISS_GROWTH = 50_000

const spendInputs = (s: Spend): SpendInputs => ({
  model: s.model,
  context: s.context,
  baseline: s.baseline,
  scale: s.scale,
  recentSteps: s.recentSteps ?? [],
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

const contextBar = (percent: number) => {
  const color = percent >= 85 ? '#e0846b' : percent >= 65 ? '#e2a94e' : MONEY
  const w = Math.round((Math.min(100, percent) / 100) * 80)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 6" width="80" height="6">
    <rect width="80" height="6" rx="3" fill="${MUTED}" fill-opacity="0.3"/>
    <rect width="${w}" height="6" rx="3" fill="${color}"/></svg>`
}

const usd = (n: number) => `$${n.toFixed(2)}`

// Density by the band's width in cells, so the row shrinks instead of wrapping:
// 0 full; 1 no context bar; 2 compact turn/speed; 3 turn cost only, smaller icons;
// 4 no speed. Thresholds are minimum bodyColumns for each tier.
const TIER_MIN = [96, 80, 64, 50] as const
const GAPS = [3, 2, 2, 1, 1] as const
const tierFor = (columns: number) => {
  const i = TIER_MIN.findIndex(min => columns >= min)
  return i === -1 ? TIER_MIN.length : i
}

// Last measured width, for `/session_data width` while tuning TIER_MIN; debug only.
let lastColumns: number | null = null

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
}

// A session's figures, saved after each answer under `session:<id>`, so a session the
// desktop app restarted or resumed draws its band at once instead of after its next answer.
type Snapshot = {
  turn: number
  total: number
  speed: number | null
  context: number
  expiresAt: number | null
  recentCosts?: number[]
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
  const key = await snapshotKey($)
  const snapshot: Snapshot = {
    turn: s.turn,
    total: s.total,
    speed: s.speed,
    context: s.context,
    expiresAt,
    recentCosts: s.recentCosts ?? [],
  }
  // Set again after a delete, the key moves last: the oldest sessions are pruned first.
  await $.store.delete(key)
  await $.store.set(key, snapshot)

  const saved = (await $.store.keys()).filter(k => k.startsWith('session:'))
  for (const old of saved.slice(0, Math.max(0, saved.length - SNAPSHOTS_KEPT))) await $.store.delete(old)
}

const restore = async ($: EngineInterface) => {
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

const refresh = async ($: EngineInterface) => {
  const { cost, context, rateLimits } = await $.session.usage()
  await saveLimits($, rateLimits)
  const usd = cost?.usd ?? 0
  await update($, stats, s => {
    const total = (s.costOffset ?? 0) + usd
    return { ...s, total, turnCost: total - s.costAtStart, context: context.percent ?? s.context }
  })
}

// Built by notifier/build.sh (macOS): posts the warning under Claude's icon.
const NOTIFIER = 'notifier/Session Band.app/Contents/MacOS/session-band-notifier'
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
      `session-band-${session?.id ?? (await $.session.id())}`,
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

export const register: Register = (on, options) => {
  const keepTurns = Math.min(20, Math.max(1, Math.round(Number(options.keepTurns ?? 3)) || 3))

  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const turns = isMain && e.trigger === 'plugin' ? keepTailTurns : null
    const result =
      turns === null ? await next(e) : await compactWithTail(e.messages, turns, older => next({ ...e, messages: older }))

    // A plain compaction's summary is measured on the next request, for the /compact estimate.
    // The context the last request carried is gone: no warning until the next one says what is left.
    if (result.messages !== undefined && isMain && e.trigger !== 'precompute') {
      await update($, spend, sp => ({ ...sp, context: null, isCompactPending: turns === null, dismissedAt: null }))
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

    await $.command.register({
      name: 'session_data',
      description: 'Show or hide the session band; `compact [turns]` compacts keeping recent turns; `demo <minutes>` previews the cache warning',
    })

    await refreshGit($)
    $.clock.every(GIT_POLL_MS, () => refreshGit($))

    $.clock.every(1000, async () => {
      const { startedAt } = await read($, turnClock)
      if (startedAt !== null) {
        const seconds = Math.max(0, Math.floor(((await $.clock.now()) - startedAt) / 1000))
        await update($, turnClock, t => (t.seconds === seconds ? t : { ...t, seconds }))
      }

      const expiresAt = (await read($, cache)).expiresAt ?? (await read($, cacheModExpiresAt))
      if (expiresAt === null) return

      const left = Math.max(0, Math.floor((expiresAt - (await $.clock.now())) / 1000))
      if (left !== (await read($, cache)).secondsLeft) {
        await update($, cache, c => ({ expiresAt: c.expiresAt ?? expiresAt, secondsLeft: left }))
      }

      const due = CACHE_NOTIFY_MINUTES.filter(m => left > 0 && left <= m * 60)
      if (due.length === 0 || (await read($, isBusy))) return

      const minutes = Math.min(...due)
      const last = await read($, warned)
      if (last !== 0 && last <= minutes) return

      await update($, warned, () => minutes)
      await notifyCacheExpiry($, Math.ceil(left / 60))
    })

    return result
  })

  on('command.run', { command: 'session_data' }, async ($, e) => {
    // `/session_data demo <minutes>` fakes the cache deadline to preview the warnings;
    // the next answer resets it.
    const demo = e.args.trim().match(/^demo\s+(\d+(?:\.\d+)?)$/)
    if (demo) {
      const seconds = Math.round(Number(demo[1]) * 60)
      const now = await $.clock.now()
      await update($, cache, () => ({ expiresAt: now + seconds * 1000, secondsLeft: seconds }))
      await update($, warned, () => 0)
      await update($, isHidden, () => false)

      return { text: `Cache demo: ${demo[1]} min left until the next answer resets it.` }
    }

    // `/session_data compact [turns]`: summarize all but the last turns, kept word for word.
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

    if (e.args.trim() === 'width') {
      const columns = lastColumns
      return { text: columns === null ? 'Band not drawn yet.' : `Band: ${columns} columns, tier ${tierFor(columns)}.` }
    }

    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)

    return { text: hidden ? 'Session band hidden.' : 'Session band shown.' }
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
    await update($, stats, s => {
      const total = (s.costOffset ?? 0) + usd
      return { ...s, turn: s.turn + 1, costAtStart: total, total }
    })
    await update($, isBusy, () => true)
    const now = await $.clock.now()
    await update($, turnClock, () => ({ startedAt: now, seconds: 0 }))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      for await (const chunk of next(e)) {
        if (chunk.kind === 'stop' && chunk.usage !== null) await recordUsage($, chunk.usage, false)
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
    await refresh($)

    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, cache, () => ({ expiresAt: now + CACHE_TTL_MS, secondsLeft: CACHE_TTL_MS / 1000 }))
      await update($, isBusy, () => false)
      await update($, warned, () => 0)
      await update($, turnClock, t => ({ ...t, startedAt: null }))
      await update($, stats, st =>
        st.turnCost === null ? st : { ...st, recentCosts: [...(st.recentCosts ?? []), st.turnCost].slice(-RECENT_TURNS) },
      )
      await settleSpend($)
      await saveSnapshot($)
      await refreshGit($)
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
    const Svg = 'Svg' in ui ? ui.Svg : null
    const speed = s.speed === null ? '—' : `${s.speed} tok/s`
    const turnCost = s.turnCost === null ? '—' : usd(s.turnCost)

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
      : `${pad(Math.floor(secondsLeft / 60))}:${pad(secondsLeft % 60)}`

    lastColumns = e.props.bodyColumns
    const tier = tierFor(e.props.bodyColumns)
    const icon = tier >= 3 ? 18 : 22

    const modelName = shortModel(await $.session.model())
    const effortLevel = await read($, effort)
    const clock = await read($, turnClock)
    const running = e.props.isWorking && clock.startedAt !== null ? elapsed(clock.seconds) : null
    const repo = await read($, git)
    const sp = await read($, spend)
    const perTurn = costPerTurn(s.recentCosts ?? [])

    // Shown while idle, when the next message is still the person's to decide.
    const warning: SpendWarning | null = e.props.isWorking
      ? null
      : secondsLeft === 0
        ? expiredWarning(spendInputs(sp))
        : sp.dismissedAt !== null && (sp.context ?? 0) < sp.dismissedAt + DISMISS_GROWTH
          ? null
          : overheadWarning(spendInputs(sp))
    // The frame takes two rows: dropped when the warning row would not fit with it.
    const framed = level !== null && e.props.maxRows >= (warning === null ? 3 : 4)

    const now = await $.clock.now()
    // A window whose reset has passed since it was saved stands at 0 until the next reading.
    const windows = Object.keys(LIMIT_LABELS).flatMap(kind => {
      const w = saved.find(l => l.kind === kind)
      if (w === undefined) return []
      return w.resetsAt !== null && Date.parse(w.resetsAt) <= now ? [{ ...w, percentUsed: 0, resetsAt: null }] : [w]
    })

    const row = (
      <Box flexDirection="row" alignItems="center" columnGap={GAPS[tier]} flexWrap="nowrap" overflow="hidden">
        {tier <= 2 ? (
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {tier <= 1 ? <Text dimColor>Turn</Text> : <Text dimColor>#</Text>}
            <Text bold>{String(s.turn)}</Text>
          </Box>
        ) : null}
        {running !== null ? (
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {tier <= 1 ? <Text dimColor>⏱</Text> : null}
            <Text bold>{running}</Text>
          </Box>
        ) : null}
        {tier <= 3 ? (
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {Svg ? <Svg source={SPEED_ICON} alt="speed" width={icon} height={icon} /> : <Text color={SPEED}>⚡</Text>}
            <Text bold wrap="truncate-end">{tier <= 1 || s.speed === null ? speed : `${s.speed}/s`}</Text>
          </Box>
        ) : null}
        <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          {Svg ? <Svg source={MONEY_ICON} alt="cost" width={icon} height={icon} /> : <Text color={MONEY}>$</Text>}
          <Text bold color={MONEY}>{turnCost}</Text>
          {perTurn !== null && tier <= 1 ? <Text dimColor>· med</Text> : null}
          {perTurn !== null && tier >= 2 ? <Text dimColor>·</Text> : null}
          {perTurn !== null ? <Text bold>{usd(perTurn.median)}</Text> : null}
          {perTurn !== null ? <Text dimColor>{tier <= 1 ? '· avg' : '/'}</Text> : null}
          {perTurn !== null ? <Text bold>{usd(perTurn.mean)}</Text> : null}
          {tier <= 2 ? <Text dimColor>|</Text> : null}
          {tier <= 2 ? <Text bold>{usd(s.total)}</Text> : null}
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          {Svg ? <Svg source={cacheIcon(cacheColor)} alt="cache" width={icon} height={icon} /> : <Text color={cacheColor}>⧗</Text>}
          <Text bold color={level ?? undefined}>{cacheText}</Text>
        </Box>
        {tier <= 3
          ? windows.map(w => {
              const reset = tier === 0 ? resetIn(w.resetsAt, now) : null
              return (
                <Box key={w.kind} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
                  <Text dimColor>{LIMIT_LABELS[w.kind]}</Text>
                  <Text bold color={limitColor(w.percentUsed)}>{`${Math.round(w.percentUsed)}%`}</Text>
                  {reset !== null ? <Text dimColor>{`↻${reset}`}</Text> : null}
                </Box>
              )
            })
          : null}
        <Box flexGrow={1} flexShrink={1} />
        {tier <= 1 && repo !== null ? (
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={1}>
            <Text dimColor>⎇</Text>
            <Text bold color={repo.isDirty ? WARN : undefined} wrap="truncate-end">{branchLabel(repo)}</Text>
          </Box>
        ) : null}
        {tier <= 2 ? (
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={1}>
            <Text bold wrap="truncate-end">{modelName}</Text>
            {tier <= 1 && effortLevel !== null ? <Text dimColor>{`· ${effortLevel}`}</Text> : null}
          </Box>
        ) : null}
        <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          {Svg ? <Svg source={contextIcon(s.context)} alt="context" width={icon} height={icon} /> : null}
          {Svg && tier === 0 ? (
            <Svg source={contextBar(s.context)} alt={`context ${s.context}%`} width={80} height={6} />
          ) : null}
          <Text bold>{`${s.context}%`}</Text>
        </Box>
        <Button key="hide" label="×" role="dismiss" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} {...(framed ? { borderStyle: 'round', borderColor: level } : {})}>
        {row}
        {warning !== null ? (
          <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="nowrap" overflow="hidden">
            <Text color={WARN} wrap="truncate-end">{warning.text}</Text>
            <Box flexGrow={1} flexShrink={1} />
            {warning.kind === 'overhead' ? (
              <Button
                key="compact"
                label={`compact, keep ${keepTurns}`}
                onPress={async () => {
                  const result = await compactKeepingTail($, keepTurns)
                  if (result.messages === undefined) $.ui.toast(`Not compacted: ${result.skip}`)
                }}
              />
            ) : null}
            {warning.kind === 'overhead' ? (
              <Button
                key="dismiss-spend"
                label="×"
                role="dismiss"
                plain
                dimColor
                onPress={() => update($, spend, s => ({ ...s, dismissedAt: s.context }))}
              />
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}
