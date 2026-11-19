import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { compactWithTail, tailStart } from './register'

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const reply = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
const toolResult = (): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ toolUseId: 't', text: 'ok' }] as unknown as SessionMessage['toolResults'],
})

// Four turns; the third has a tool round trip inside it.
const CONVERSATION = [
  prompt('one'),
  reply('a'),
  prompt('two'),
  reply('b'),
  prompt('three'),
  reply('calling'),
  toolResult(),
  reply('c'),
  prompt('four'),
  reply('d'),
]

const RUN = (args: string) =>
  ({ command: 'session_data', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as const

test('a turn starts at a prompt the person wrote, not at tool results', async () => {
  expect(tailStart(CONVERSATION, 1)).toBe(8)
  expect(tailStart(CONVERSATION, 2)).toBe(4)
  // Every turn kept: nothing left to summarize.
  expect(tailStart(CONVERSATION, 4)).toBe(-1)
})

test('the older turns are summarized and the kept ones follow the summary word for word', async () => {
  const summarized: string[][] = []
  const result = await compactWithTail(CONVERSATION, 2, async older => {
    summarized.push(older.map(m => m.text))
    return { messages: [prompt('SUMMARY')], tokensBefore: 100_000, tokensAfter: 2_000 }
  })
  expect(summarized).toEqual([['one', 'a', 'two', 'b']])
  expect(result.messages?.map(m => m.text)).toEqual(['SUMMARY', 'three', 'calling', '', 'c', 'four', 'd'])
  // The engine's count no longer holds with the kept turns added.
  expect('tokensAfter' in result).toBe(false)
})

test('too few turns to keep: nothing is summarized', async () => {
  let calls = 0
  const result = await compactWithTail(CONVERSATION, 4, async () => (calls++, { messages: [] }))
  expect(result).toEqual({ skip: 'Nothing before the last 4 turns to summarize.' })
  expect(calls).toBe(0)
})

test('a summarizer that skips is passed on', async () => {
  const result = await compactWithTail(CONVERSATION, 1, async () => ({ skip: 'vetoed' }))
  expect(result).toEqual({ skip: 'vetoed' })
})

test('the command schedules the compaction after it returns, keeping the set turns', { options: { keepTurns: 1 } }, async ($, on) => {
  const scheduled: number[] = []
  // Held, not fired: a command cannot compact under the turn it answers.
  on('clock.after', (_, e) => (scheduled.push(e.ms), { value: undefined }))
  const byDefault = await $.command.run(RUN('compact'))
  expect(byDefault.text).toBe('Compacting, keeping the last 1 turn…')
  const named = await $.command.run(RUN('compact 5'))
  expect(named.text).toBe('Compacting, keeping the last 5 turns…')
  expect(scheduled).toEqual([0, 0])
})
