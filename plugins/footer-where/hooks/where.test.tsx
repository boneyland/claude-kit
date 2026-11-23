import { expect, test } from 'claude-code/testing'

import { tilde } from './register'

const PLUGIN = 'footer-where'

test('home is shortened to ~, and only on a whole folder name', () => {
  expect(tilde('/home/yh/projects/x', '/home/yh')).toBe('~/projects/x')
  expect(tilde('/home/yh', '/home/yh')).toBe('~')
  expect(tilde('/home/yhx/a', '/home/yh')).toBe('/home/yhx/a')
  expect(tilde('/srv/a', undefined)).toBe('/srv/a')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the footer shows the directory and branch after the mode labels, and follows a checkout`, async ($, on) => {
    let branch: string | null = 'main'
    on('session.cwd', () => ({ value: '/home/yh/projects/claude-kit' }))
    on('env.get', () => ({ value: '/home/yh' }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('turn.complete', () => ({ text: '' }) as never)
    on('vcs.detect', () => ({ vcs: 'git', root: '/home/yh/projects/claude-kit', mainRoot: null, revision: null, branch, defaultBranch: 'main', remote: null }))
    await $.session.start({ cwd: '/home/yh/projects/claude-kit', surface, isInteractive: true })

    const ui = await $.ui.mount({ plugin: PLUGIN, component: 'SessionMode', surface, props: { modes: ['auto mode on'] } })
    const shown = async () => JSON.stringify(await ui.find({ type: 'Box' }))
    expect(await shown()).toContain('"engine"')
    expect(await shown()).toContain('~/projects/claude-kit')
    expect(await shown()).toContain('"main"')

    branch = 'feature'
    await $.turn.complete({ reason: 'answer', answer: '' } as never)
    expect(await shown()).toContain('"feature"')

    // Off a branch (detached head) the directory stands alone.
    branch = null
    await $.turn.complete({ reason: 'answer', answer: '' } as never)
    expect(await shown()).not.toContain(' · ')
    await ui.unmount()
  })
}
