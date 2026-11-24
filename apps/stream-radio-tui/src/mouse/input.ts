import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { splitMouse, type MouseEvent, type MouseSource } from './sgr'

// Stands between the terminal and Ink: Ink reads the keys from `stdin`, the
// mouse reports go to `subscribe`rs instead, so none reach the key handler.
// `close` lets go of the terminal's stdin, so it keeps the process alive no longer.
// `off`: turns the terminal's mouse reports off, called as Ink leaves raw mode
// and before the terminal echoes again, so a report sent while quitting is
// not printed in the shell.
export function mouseInput(real: NodeJS.ReadStream, off?: () => void): { stdin: NodeJS.ReadStream; subscribe: MouseSource; close(): void } {
  const out = new PassThrough()
  const fns = new Set<(e: MouseEvent) => void>()
  let held = ''
  // a character split across two reads stays whole
  const utf8 = new StringDecoder('utf8')
  const onData = (d: Buffer | string) => {
    const r = splitMouse(held, typeof d === 'string' ? d : utf8.write(d))
    held = r.held
    if (r.text) out.write(r.text)
    for (const e of r.events) for (const fn of fns) fn(e)
  }
  real.on('data', onData)
  const stdin = Object.assign(out, {
    isTTY: real.isTTY,
    // Ink reads only while raw; the probe before it left stdin paused, and a
    // paused stream stays paused when a data listener is added.
    setRawMode: (mode: boolean) => {
      if (!mode) off?.()
      real.setRawMode?.(mode)
      if (mode) real.resume()
      else real.pause()
      return stdin
    },
    ref: () => {
      real.ref?.()
      return stdin
    },
    unref: () => {
      real.unref?.()
      return stdin
    },
  }) as unknown as NodeJS.ReadStream
  const subscribe: MouseSource = fn => {
    fns.add(fn)
    return () => void fns.delete(fn)
  }
  const close = () => {
    real.off('data', onData)
    real.pause()
    fns.clear()
  }
  return { stdin, subscribe, close }
}
