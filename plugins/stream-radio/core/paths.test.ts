import { expect, test } from 'claude-code/testing'

import { stateDir } from './paths'

const envOf = (vars: Record<string, string>) => async (name: string) => vars[name]

test('XDG_STATE_HOME holds the folder when set', async () => {
  expect(await stateDir(envOf({ XDG_STATE_HOME: '/x', HOME: '/h' }))).toBe('/x/stream-radio')
})

test('without it the folder is under HOME/.local/state', async () => {
  expect(await stateDir(envOf({ HOME: '/h' }))).toBe('/h/.local/state/stream-radio')
  expect(await stateDir(envOf({ XDG_STATE_HOME: '', HOME: '/h' }))).toBe('/h/.local/state/stream-radio')
})

test('with neither it is empty, so the core asks again later', async () => {
  expect(await stateDir(envOf({}))).toBe('')
  expect(await stateDir(envOf({ HOME: '' }))).toBe('')
})
