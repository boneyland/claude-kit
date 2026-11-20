// mpv prints one status line per update; we ask it for "NP<TAB>title<TAB>icy<TAB>meta".
export const STATUS_FORMAT =
  'NP\t${media-title:}\t${metadata/by-key/icy-title:}\t${metadata/by-key/title:}'

export type Track = { title: string; isSong: boolean }

// The last complete NP line in a chunk of mpv output (lines end in \r or \n).
// A song title (stream metadata) wins over the page's media title.
export function parseNowPlaying(text: string): Track | undefined {
  const lines = text.split(/[\r\n]+/).filter(line => line.startsWith('NP\t'))
  const last = lines[lines.length - 1]
  if (!last) return undefined
  const [, media = '', icy = '', meta = ''] = last.split('\t')
  const song = icy.trim() || meta.trim()
  const title = song || media.trim()

  return title ? { title, isSong: Boolean(song) && song !== media.trim() } : undefined
}

export function parseArgs(
  args: string,
  fallback: string,
): { kind: 'stop' } | { kind: 'play'; url: string } | { kind: 'error'; text: string } {
  const word = args.trim()
  if (word === 'stop' || word === 'off') return { kind: 'stop' }
  const url = word || fallback
  if (!url) return { kind: 'error', text: 'Usage: /stream <url> | /stream stop' }
  if (!/^https?:\/\/\S+$/.test(url)) {
    return { kind: 'error', text: `Not an http(s) URL: ${url}` }
  }

  return { kind: 'play', url }
}
