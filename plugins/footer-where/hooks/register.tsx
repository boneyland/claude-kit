import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Where } from '../types'

const where = atom({ plugin: 'footer-where', key: 'where' } as const, null as Where | null)

export const tilde = (dir: string, home: string | undefined): string =>
  home && (dir === home || dir.startsWith(home + '/')) ? '~' + dir.slice(home.length) : dir

// Read the directory and branch again. Writes only on a change, so the footer
// redraws only when there is something new to show.
const refresh = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
  const copy = await $.vcs.detect({ path: cwd }).catch(() => null)
  const next: Where = { dir: tilde(cwd, await $.env.get('HOME')), branch: copy?.branch ?? null }
  await update($, where, prev => (prev && prev.dir === next.dir && prev.branch === next.branch ? prev : next))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  // A tool call can switch branches (`git checkout`) or move the session
  // (a worktree); a finished turn catches anything else, such as `/cd`.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await refresh($).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await refresh($).catch(() => undefined)
    return next(e)
  })

  // The directory and branch after the engine's mode labels and anything other
  // mods put there. SessionMode is already the slot at the right of the footer:
  // nothing here may grow, or the slot takes a row of its own.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const w = await read($, where)
    const drawn = await next(e)
    if (!w) return drawn
    return (
      <Box flexDirection="row" gap={1}>
        {drawn}
        <Text dimColor wrap="truncate-start">
          {w.dir}
          {w.branch ? ' · ' : ''}
          {w.branch ? <Text color="cyan">{w.branch}</Text> : null}
        </Text>
      </Box>
    )
  })
}
