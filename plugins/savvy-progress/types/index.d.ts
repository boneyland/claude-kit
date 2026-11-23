export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** One row of Claude Code's own task list, as the task tools' calls and results told it. */
export type TaskItem = {
  id: string
  subject: string
  activeForm?: string
  status: TaskStatus
}

export type TaskMirror = {
  items: TaskItem[]
  /** Which tools keep the list: TaskCreate/TaskUpdate (`task`) or TodoWrite (`todo`); the nudge names them. */
  kind: 'task' | 'todo'
  /** Main-session tool calls since the list last changed, counted while a task is open. */
  sinceUpdate: number
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      // Whether the agents pane is up, for the footer button's label.
      isOpen: boolean
      // Claude Code's own task list, mirrored for the bar when no flow is reported.
      tasks: TaskMirror
      // What the main session is doing: its latest tool call, in a few words; empty between turns.
      activity: string
    }
  }
}
