import type { GraphicsSetting } from '../config'

// A terminal cell's size in pixels.
export type Cell = { width: number; height: number }
// When the terminal doesn't say: about the usual 2:1.
export const FALLBACK_CELL: Cell = { width: 8, height: 16 }

export type Probe = { kitty: boolean; cell?: Cell }

// Asks for Kitty graphics (a query that draws nothing), the cell size in
// pixels, then the device attributes. Every terminal answers the last, so its
// answer marks the end: a graphics OK before it means support.
const QUERY = '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[c'

// What the terminal has answered so far.
export function parseProbeReply(reply: string): Probe & { isDone: boolean } {
  const end = reply.search(/\x1b\[\?[\d;]*c/)
  const isDone = end >= 0
  const before = isDone ? reply.slice(0, end) : reply
  const kitty = /\x1b_Gi=31;OK\x1b\\/.test(before)
  const size = /\x1b\[6;(\d+);(\d+)t/.exec(reply)
  const cell = size ? { width: Number(size[2]), height: Number(size[1]) } : undefined
  return { kitty, ...(cell && cell.width > 0 && cell.height > 0 ? { cell } : {}), isDone }
}

// The terminal's answer, read before Ink takes stdin; nothing read reaches
// Ink. Without a terminal on both ends nothing is asked.
export async function probeTerminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, timeoutMs = 300): Promise<Probe> {
  if (!stdin.isTTY || !stdout.isTTY) return { kitty: false }
  const wasRaw = stdin.isRaw === true
  stdin.setRawMode(true)
  let reply = ''
  try {
    return await new Promise<Probe>(resolve => {
      const finish = () => {
        clearTimeout(timer)
        stdin.off('data', onData)
        const { kitty, cell } = parseProbeReply(reply)
        resolve(cell ? { kitty, cell } : { kitty })
      }
      const onData = (chunk: Buffer | string) => {
        reply += chunk.toString()
        if (parseProbeReply(reply).isDone) finish()
      }
      // A terminal that never finishes answering: what arrived counts.
      const timer = setTimeout(finish, timeoutMs)
      stdin.on('data', onData)
      stdout.write(QUERY)
    })
  } finally {
    stdin.setRawMode(wasRaw)
    stdin.pause()
  }
}

// Whether to draw pictures. `auto` trusts a terminal that answered, except
// inside tmux or screen (no passthrough here) and in terminals known to
// support the protocol but not its placeholder cells: WezTerm (support is in
// progress, wezterm/wezterm#7924) and Konsole.
export function graphicsOn(env: Record<string, string | undefined>, setting: GraphicsSetting, probe: Probe): boolean {
  if (setting !== 'auto') return setting === 'on'
  if (env.TMUX || env.STY) return false
  if (env.TERM_PROGRAM === 'WezTerm' || env.KONSOLE_VERSION) return false
  return probe.kitty
}
