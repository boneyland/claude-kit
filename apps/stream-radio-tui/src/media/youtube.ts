import type { Host } from '@core/host'

export type Video = { url: string; title: string; channel: string }
export type PlaylistListing = { title: string; entries: Video[] } | { error: string }

// How many videos a listing reads at most, so a huge channel stays bounded.
const MAX_ENTRIES = 1000

const text = (v: unknown) => (typeof v === 'string' ? v : '')

// A YouTube (or other yt-dlp) playlist's videos, without fetching each one;
// a single video's URL lists that video alone.
export async function listPlaylist(h: Host, url: string): Promise<PlaylistListing> {
  let result
  try {
    result = await h.run(['yt-dlp', '--flat-playlist', '-J', '--playlist-end', String(MAX_ENTRIES), url], { timeoutMs: 60000 })
  } catch (error) {
    return { error: `yt-dlp couldn't run: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (result.exitCode !== 0) {
    const errors = result.stderr.split('\n').filter(l => l.startsWith('ERROR:'))
    const last = errors[errors.length - 1]
    return { error: last ? last.slice('ERROR:'.length).trim() : `yt-dlp failed (exit ${result.exitCode}).` }
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(result.stdout)
  } catch {
    return { error: "yt-dlp's listing couldn't be read." }
  }
  if (!data || typeof data !== 'object') return { error: "yt-dlp's listing couldn't be read." }
  const channelOf = (e: Record<string, unknown>) => text(e.channel) || text(e.uploader)
  if (!Array.isArray(data.entries)) {
    const one = text(data.webpage_url) || text(data.original_url) || url
    return { title: text(data.title) || one, entries: [{ url: one, title: text(data.title) || one, channel: channelOf(data) }] }
  }
  const entries = (data.entries as Record<string, unknown>[]).flatMap(e => {
    const u = e && typeof e === 'object' ? text(e.url) : ''
    return u ? [{ url: u, title: text(e.title) || u, channel: channelOf(e) }] : []
  })
  return { title: text(data.title) || url, entries }
}
