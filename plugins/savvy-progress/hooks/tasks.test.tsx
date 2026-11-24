import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never } as const

// The test's tool.call hooks stand for Claude Code: TaskCreate hands out ids, the rest succeed.
async function session($: Engine, on: On) {
  mock.clock(on, { now: Date.parse('2026-11-24T02:00:00Z') })
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('settings.read', async () => ({ value: {} }) as never)
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  let id = 0
  on('tool.call', async (_$, e) => {
    const a = e as unknown as Record<string, unknown>
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++id), subject: a.subject } } } as never
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: a.taskId, updatedFields: ['status'] } } as never
    if (e.tool === 'TodoWrite') return { result: { oldTodos: [], newTodos: a.todos } } as never
    return { result: 'ok' } as never
  })
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

async function texts($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface, ...BAND })
  const all = (await ui.findAll({ type: 'Text' })).map(n => String((n as { text?: string }).text ?? ''))
  await ui.unmount()
  return all
}

const create = ($: Engine, subject: string, activeForm?: string) =>
  $.tool.call({ tool: 'TaskCreate', subject, description: subject, activeForm } as never)
const set = ($: Engine, taskId: string, status: string) => $.tool.call({ tool: 'TaskUpdate', taskId, status } as never)

test('no task list and no flow: no band row', async ($, on) => {
  await session($, on)
  expect((await texts($)).some(t => /Tasks/.test(t))).toBe(false)
})

test('the band mirrors TaskCreate/TaskUpdate: current task, count and activity', async ($, on) => {
  await session($, on)
  await create($, 'Write the parser', 'Writing the parser')
  await create($, 'Test the parser')
  await create($, 'Document it')
  await set($, '1', 'completed')
  await set($, '2', 'in_progress')
  await $.tool.call({ tool: 'Bash', command: 'bun test', description: 'Run the parser tests' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const all = await texts($, surface)
    if (surface === 'terminal') {
      expect(all).toContain('Test the parser')
      expect(all).toContain('Tasks 1/3')
      expect(all).toContain('· Run the parser tests')
    } else {
      expect(all).toContain('Run the parser tests')
    }
  }
})

test('a deleted task leaves the count; all completed shows Done, and the next prompt clears it', async ($, on) => {
  await session($, on)
  await create($, 'A')
  await create($, 'B')
  await set($, '2', 'deleted')
  await set($, '1', 'completed')
  expect(await texts($)).toContain('Done')
  await $.prompt.submit({ text: 'next thing' } as never)
  expect((await texts($)).some(t => t === 'Done' || /^Tasks/.test(t))).toBe(false)
})

test('TodoWrite is mirrored too', async ($, on) => {
  await session($, on)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'One', status: 'completed', activeForm: 'Doing one' },
      { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
    ],
  } as never)
  const all = await texts($)
  expect(all).toContain('Doing two')
  expect(all).toContain('Tasks 1/2')
})

const PLAN = 'mcp__ccd_turn__update_plan'
const plan = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: PLAN, ...input } as never)

test("the desktop app's update_plan is mirrored: items, advance, done/start, and the turn's end checks off the last step", async ($, on) => {
  on('turn.complete', () => ({ text: '' }) as never)
  await session($, on)
  await plan($, {
    scope: 'continuation',
    items: [
      { content: 'Read the code', status: 'in_progress' },
      { content: 'Mirror update_plan', status: 'pending' },
      { content: 'Run the tests', status: 'pending' },
    ],
  })
  let all = await texts($)
  expect(all).toContain('Read the code')
  expect(all).toContain('Tasks 0/3')

  await plan($, { advance: true })
  all = await texts($)
  expect(all).toContain('Mirror update_plan')
  expect(all).toContain('Tasks 1/3')

  await plan($, { done: [2], start: 3 })
  all = await texts($)
  expect(all).toContain('Run the tests')
  expect(all).toContain('Tasks 2/3')

  // A subagent's turn ending leaves the main list alone; the main turn's end finishes it.
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'answer', answer: '' })
  expect(await texts($)).toContain('Tasks 2/3')
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: '' })
  expect(await texts($)).toContain('Done')
})

test('an update_plan list is never nudged', async ($, on) => {
  await session($, on)
  await plan($, { items: [{ content: 'Long step', status: 'in_progress' }] })
  for (let i = 1; i <= 30; i++) {
    const r = (await $.tool.call({ tool: 'Read', file_path: `/repo/f${i}.ts` } as never)) as { context?: string[] }
    expect(r.context ?? []).toEqual([])
  }
})

test('a stale open list gets one reminder on the 15th tool result, then again 15 later', async ($, on) => {
  await session($, on)
  await create($, 'Long task')
  await set($, '1', 'in_progress')
  const nudged: number[] = []
  for (let i = 1; i <= 30; i++) {
    const r = (await $.tool.call({ tool: 'Read', file_path: `/repo/f${i}.ts` } as never)) as { context?: string[] }
    if (r.context?.some(c => c.includes('TaskUpdate'))) nudged.push(i)
  }
  expect(nudged).toEqual([15, 30])
})

test('a task-list change resets the count; a subagent call is not counted', async ($, on) => {
  await session($, on)
  await create($, 'Long task')
  let nudges = 0
  for (let i = 1; i <= 20; i++) {
    if (i === 10) await set($, '1', 'in_progress')
    const r = (await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: i % 2 ? 'a1' : undefined } as never)) as {
      context?: string[]
    }
    if (r.context?.length) nudges++
  }
  expect(nudges).toBe(0)
})

test('a closed list is never nudged', async ($, on) => {
  await session($, on)
  await create($, 'Quick')
  await set($, '1', 'completed')
  for (let i = 0; i < 20; i++) {
    const r = (await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)) as { context?: string[] }
    expect(r.context ?? []).toEqual([])
  }
})

test('mirror mode draws the bar but never nudges', { options: { taskList: 'mirror' } }, async ($, on) => {
  await session($, on)
  await create($, 'Long task')
  for (let i = 0; i < 20; i++) {
    const r = (await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)) as { context?: string[] }
    expect(r.context ?? []).toEqual([])
  }
  expect(await texts($)).toContain('Tasks 0/1')
})

test('off mode: no bar from the task list', { options: { taskList: 'off' } }, async ($, on) => {
  await session($, on)
  await create($, 'Long task')
  expect((await texts($)).some(t => /^Tasks/.test(t))).toBe(false)
})

test('a reported flow wins over the task list', async ($, on) => {
  await session($, on)
  await create($, 'Mirrored')
  await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
  const all = await texts($)
  expect(all).toContain('Ship it')
  expect(all).toContain('Tasks 1/4')
})
