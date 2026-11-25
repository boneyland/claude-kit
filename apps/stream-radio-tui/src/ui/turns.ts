import { useRef } from 'react'

export type Work = () => Promise<string | void>

// inTurn: `work` runs once the work before it is done, reading the state as
// that left it: keys in one stdin chunk would otherwise all read the same
// value (a volume step, a move, a removal). act: runs `work` and shows its
// reply, or why it failed, through `say`.
export type Turns = { inTurn(work: Work): Promise<string | void>; act(work: Work): void }

export function useTurns(say: (text: string) => void): Turns {
  const turns = useRef<Promise<unknown>>(Promise.resolve())
  return {
    inTurn: work => {
      const run = turns.current.then(work)
      turns.current = run.catch(() => undefined)
      return run
    },
    act: work => {
      work().then(
        reply => say(reply ?? ''),
        error => say(`stream-radio failed: ${error instanceof Error ? error.message : String(error)}`),
      )
    },
  }
}
