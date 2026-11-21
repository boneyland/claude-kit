// mpv prints one status line per update; we ask it for
// "NP<TAB>title<TAB>icy<TAB>meta<TAB>pause<TAB>percent".
export const STATUS_FORMAT =
  'NP\t${media-title:}\t${metadata/by-key/icy-title:}\t${metadata/by-key/title:}\t${pause:}\t${percent-pos:}'

// percent: how far into the current file, 0 to 100; null for a live stream.
export type Track = { title: string; isPaused: boolean; percent: number | null }

// The last complete NP line in a chunk of mpv output (lines end in \r or \n).
// A song title (stream metadata) wins over the page's media title.
export function parseNowPlaying(text: string): Track | undefined {
  const lines = text.split(/[\r\n]+/).filter(line => line.startsWith('NP\t'))
  const last = lines[lines.length - 1]
  if (!last) return undefined
  const [, media = '', icy = '', meta = '', pause = '', pos = ''] = last.split('\t')
  const title = icy.trim() || meta.trim() || media.trim()

  const percent = pos.trim() === '' || Number.isNaN(Number(pos)) ? null : Math.floor(Number(pos))

  return title ? { title, isPaused: pause.trim() === 'yes', percent } : undefined
}

export type Command =
  | { kind: 'stop' }
  | { kind: 'toggle' }
  | { kind: 'play'; url: string }
  | { kind: 'error'; text: string }

export function parseArgs(args: string, fallback: string): Command {
  const word = args.trim()
  if (word === 'stop' || word === 'off') return { kind: 'stop' }
  if (word === 'pause' || word === 'resume' || word === 'toggle') return { kind: 'toggle' }
  const url = word || fallback
  if (!url) return { kind: 'error', text: 'Usage: /stream <url> | pause | stop' }
  if (!/^https?:\/\/\S+$/.test(url)) {
    return { kind: 'error', text: `Not an http(s) URL: ${url}` }
  }

  return { kind: 'play', url }
}
