// Claude Code's own task list, mirrored from the task tools' calls and results,
// and the main session's current activity. Pure functions: register.tsx holds
// the state and the hooks.
import type { Flow, TaskItem, TaskMirror, TaskStatus } from '../types'

// TaskGet only reads one task, so it neither changes the list nor resets the nudge count.
// The desktop app's own task list (shown under Claude's message) is kept with PLAN_TOOL instead.
export const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
export const TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite', 'TaskList', PLAN_TOOL])

// Main-session tool calls, with a task still open and no task-list change, before
// one reminder rides along with a tool result. Again after as many more.
export const NUDGE_AFTER = 15

const MAX_ITEMS = 200
const MAX_SUBJECT = 120
const MAX_ACTIVITY = 80

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)
const line = (v: unknown, max = MAX_SUBJECT): string =>
  typeof v === 'string' ? clip(v.replace(/\s+/g, ' ').trim(), max) : ''
const statusOf = (v: unknown, fallback: TaskStatus): TaskStatus =>
  v === 'pending' || v === 'in_progress' || v === 'completed' ? v : fallback

export const isOpen = (m: TaskMirror): boolean => m.items.some(t => t.status !== 'completed')

type Call = Record<string, unknown> & { tool: string }

/**
 * The list after one task-tool call that ran without error: `input` is the call as
 * the model wrote it, `result` the tool's record. Anything it cannot read leaves
 * the list as it was.
 */
export const applyTaskCall = (m: TaskMirror, input: Call, result: unknown): TaskMirror => {
  const r = (result ?? {}) as Record<string, unknown>
  const touched = { ...m, sinceUpdate: 0 }

  if (input.tool === 'TodoWrite') {
    const todos = Array.isArray(r.newTodos) ? r.newTodos : Array.isArray(input.todos) ? input.todos : null
    if (!todos) return m
    const items = todos.slice(0, MAX_ITEMS).map((t: Record<string, unknown>, i): TaskItem => ({
      id: String(i + 1),
      subject: line(t.content) || `#${i + 1}`,
      activeForm: line(t.activeForm) || undefined,
      status: statusOf(t.status, 'pending'),
    }))
    return { items, kind: 'todo', sinceUpdate: 0 }
  }

  if (input.tool === PLAN_TOOL) return applyPlanCall(m, input)

  if (input.tool === 'TaskCreate') {
    const task = (r.task ?? {}) as Record<string, unknown>
    const id = typeof task.id === 'string' ? task.id : typeof task.id === 'number' ? String(task.id) : ''
    if (!id) return m
    // A list whose every task is done is over: a new task starts a new one.
    const kept = m.kind === 'task' && isOpen(m) ? m.items.filter(t => t.id !== id) : []
    const item: TaskItem = {
      id,
      subject: line(task.subject) || line(input.subject) || `#${id}`,
      activeForm: line(input.activeForm) || undefined,
      status: 'pending',
    }
    return { items: [...kept, item].slice(-MAX_ITEMS), kind: 'task', sinceUpdate: 0 }
  }

  if (input.tool === 'TaskUpdate') {
    if (r.success === false) return touched
    const id = String(input.taskId ?? r.taskId ?? '')
    if (input.status === 'deleted') return { ...touched, items: m.items.filter(t => t.id !== id) }
    if (!m.items.some(t => t.id === id)) return touched
    return {
      ...touched,
      kind: 'task',
      items: m.items.map(t =>
        t.id !== id
          ? t
          : {
              ...t,
              subject: line(input.subject) || t.subject,
              activeForm: line(input.activeForm) || t.activeForm,
              status: statusOf(input.status, t.status),
            },
      ),
    }
  }

  if (input.tool === 'TaskList') {
    // The engine's own word on the list: what the mirror missed (a compaction, a
    // resume) comes back here. A read, so the nudge count stays.
    if (!Array.isArray(r.tasks)) return m
    const known = new Map(m.items.map(t => [t.id, t]))
    const items = r.tasks.slice(0, MAX_ITEMS).map((t: Record<string, unknown>): TaskItem => {
      const id = String(t.id ?? '')
      return {
        id,
        subject: line(t.subject) || known.get(id)?.subject || `#${id}`,
        activeForm: known.get(id)?.activeForm,
        status: statusOf(t.status, 'pending'),
      }
    })
    return { ...m, items, kind: 'task' }
  }

  return m
}

/**
 * The desktop app's plan tool: `items` replaces the whole list; otherwise
 * `advance` completes the step in progress and starts the next pending one, and
 * `done` (1-based) completes steps and `start` starts one.
 */
const applyPlanCall = (m: TaskMirror, input: Call): TaskMirror => {
  if (Array.isArray(input.items)) {
    const items = input.items.slice(0, MAX_ITEMS).map((t: Record<string, unknown>, i): TaskItem => ({
      id: String(i + 1),
      subject: line(t?.content) || `#${i + 1}`,
      status: statusOf(t?.status, 'pending'),
    }))
    return { items, kind: 'plan', sinceUpdate: 0 }
  }
  if (m.kind !== 'plan') return m
  const items = m.items.map(t => ({ ...t }))
  const at = (n: unknown): TaskItem | undefined =>
    typeof n === 'number' && Number.isInteger(n) ? items[n - 1] : undefined
  if (input.advance === true) {
    const current = items.findIndex(t => t.status === 'in_progress')
    if (current >= 0) items[current].status = 'completed'
    const nextUp = items.find((t, i) => i > current && t.status === 'pending') ?? items.find(t => t.status === 'pending')
    if (nextUp) nextUp.status = 'in_progress'
  }
  if (Array.isArray(input.done)) for (const n of input.done) { const t = at(n); if (t) t.status = 'completed' }
  const started = at(input.start)
  if (started) started.status = 'in_progress'
  return { ...m, items, sinceUpdate: 0 }
}

/** The app checks off the plan's last step when the main turn ends normally. */
export const finishPlan = (m: TaskMirror): TaskMirror =>
  m.kind === 'plan' && m.items.some(t => t.status === 'in_progress')
    ? { ...m, items: m.items.map(t => (t.status === 'in_progress' ? { ...t, status: 'completed' } : t)) }
    : m

/** The task list as a flow, so the band draws it with the flow's own row. */
export const taskFlow = (m: TaskMirror, word: string): Flow => {
  const done = m.items.filter(t => t.status === 'completed').length
  const current = m.items.find(t => t.status === 'in_progress')
  return {
    title: current ? current.activeForm || current.subject : word,
    total: m.items.length,
    done,
    running: m.items.filter(t => t.status === 'in_progress').length,
    phase: 'delegate',
    isFinished: m.items.length > 0 && done === m.items.length,
    tasks: [],
  }
}

export const nudgeText = (kind: TaskMirror['kind']): string =>
  `The task list has not changed in the last ${NUDGE_AFTER} tool calls while tasks are still open. ` +
  `If a task has finished or another has started, update the list now with ${kind === 'todo' ? 'TodoWrite' : 'TaskUpdate'}; ` +
  'if it still matches the work, carry on. Do not mention this reminder.'

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** A main-session tool call in a few words, for the band: what Claude is doing now. */
export const activityOf = (e: Call): string => {
  const s = (k: string): string => line(e[k], MAX_ACTIVITY)
  const said = (() => {
    switch (e.tool) {
      case 'Bash':
        return s('description') || `$ ${s('command')}`
      case 'Read':
      case 'Write':
      case 'Edit':
        return `${e.tool} ${baseName(s('file_path'))}`
      case 'NotebookEdit':
        return `Edit ${baseName(s('notebook_path'))}`
      case 'Grep':
      case 'Glob':
        return `${e.tool} ${s('pattern')}`
      case 'Agent':
        return `Agent: ${s('description')}`
      case 'WebSearch':
        return `Search: ${s('query')}`
      case 'WebFetch':
        return `Fetch ${s('url')}`
      case 'Skill':
        return `Skill ${s('skill')}`
      default:
        // mcp__server__tool reads as server: tool.
        return e.tool.replace(/^mcp__(.+?)__(.+)$/, '$1: $2')
    }
  })()
  return clip(said.trim() || e.tool, MAX_ACTIVITY)
}
