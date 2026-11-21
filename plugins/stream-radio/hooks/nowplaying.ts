// mpv prints one status line per update; we ask it for
// "NP<TAB>title<TAB>icy<TAB>meta<TAB>pause<TAB>percent<TAB>END". mpv ends no line:
// it starts the next update with a newline, so END is what marks a line as whole.
export const STATUS_FORMAT =
  'NP\t${media-title:}\t${metadata/by-key/icy-title:}\t${metadata/by-key/title:}\t${pause:}\t${percent-pos:}\tEND'

// percent: how far into the current file, 0 to 100; null for a live stream.
// isPaused: null when the line does not say (a cut-off line), so nothing changes.
export type Track = { title: string; isPaused: boolean | null; percent: number | null }

// The last complete NP line in a chunk of mpv output (lines end in \r or \n).
// A song title (stream metadata) wins over the page's media title.
export function parseNowPlaying(text: string): Track | undefined {
  const lines = text.split(/[\r\n]+/).filter(line => line.startsWith('NP\t'))
  const last = lines[lines.length - 1]
  if (!last) return undefined
  const [, media = '', icy = '', meta = '', pause = '', pos = ''] = last.split('\t')
  const title = icy.trim() || meta.trim() || media.trim()

  const percent = pos.trim() === '' || Number.isNaN(Number(pos)) ? null : Math.floor(Number(pos))

  const isPaused = pause.trim() === 'yes' ? true : pause.trim() === 'no' ? false : null

  return title ? { title, isPaused, percent } : undefined
}

// mpv's output arrives in pieces that do not line up with its lines, and it
// does not end a status line until the next one is printed. Splits what has been
// read into the whole lines (up to the last END marker) and the unfinished rest,
// which waits for the next piece.
export function completeLines(buffer: string): { complete: string; rest: string } {
  const mark = buffer.lastIndexOf('\tEND')
  if (mark < 0) return { complete: '', rest: buffer.length > 10000 ? '' : buffer }
  const cut = mark + '\tEND'.length

  return { complete: buffer.slice(0, cut), rest: buffer.slice(cut) }
}

export type Command =
  | { kind: 'stop' }
  | { kind: 'toggle' }
  | { kind: 'last' }
  | { kind: 'play'; url: string }
  | { kind: 'error'; text: string }

export function parseArgs(args: string, fallback: string): Command {
  const word = args.trim()
  if (word === 'stop' || word === 'off') return { kind: 'stop' }
  if (word === 'pause' || word === 'resume' || word === 'toggle') return { kind: 'toggle' }
  if (word === 'last') return { kind: 'last' }
  const url = word || fallback
  if (!url) return { kind: 'error', text: 'Usage: /stream <url> | last | pause | stop' }
  if (!/^https?:\/\/\S+$/.test(url)) {
    return { kind: 'error', text: `Not an http(s) URL: ${url}` }
  }

  return { kind: 'play', url }
}
