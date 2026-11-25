import { describe, expect, test, vi } from 'vitest'
import type { Host } from '@core/host'
import { listPlaylist } from '@core/expand'

const hostRunning = (result: { exitCode: number; stdout: string; stderr: string }) => {
  const run = vi.fn(async () => result)
  return { h: { run } as unknown as Host, run }
}

describe('listPlaylist', () => {
  test('a playlist: its title and the entries that have a URL', async () => {
    const out = {
      _type: 'playlist',
      title: 'My Mix',
      entries: [
        { url: 'https://www.youtube.com/watch?v=a', title: 'First', channel: 'Chan A' },
        { title: 'Gone', channel: 'Chan B' },
        { url: 'https://www.youtube.com/watch?v=c', title: 'Third', uploader: 'Up C' },
      ],
    }
    const { h, run } = hostRunning({ exitCode: 0, stdout: JSON.stringify(out), stderr: '' })
    expect(await listPlaylist(h, 'https://youtube.com/playlist?list=x')).toEqual({
      title: 'My Mix',
      entries: [
        { url: 'https://www.youtube.com/watch?v=a', title: 'First', channel: 'Chan A' },
        { url: 'https://www.youtube.com/watch?v=c', title: 'Third', channel: 'Up C' },
      ],
    })
    expect(run).toHaveBeenCalledWith(['yt-dlp', '--flat-playlist', '-J', '--playlist-end', '1000', 'https://youtube.com/playlist?list=x'], { timeoutMs: 60000 })
  })
  test('a single video is one entry', async () => {
    const out = { _type: 'video', title: 'Solo', channel: 'Me', webpage_url: 'https://www.youtube.com/watch?v=s' }
    const { h } = hostRunning({ exitCode: 0, stdout: JSON.stringify(out), stderr: '' })
    expect(await listPlaylist(h, 'https://youtu.be/s')).toEqual({ title: 'Solo', entries: [{ url: 'https://www.youtube.com/watch?v=s', title: 'Solo', channel: 'Me' }] })
  })
  test("an error: yt-dlp's last ERROR line", async () => {
    const { h } = hostRunning({ exitCode: 1, stdout: '', stderr: 'WARNING: x\nERROR: [youtube] abc: Private video\n' })
    expect(await listPlaylist(h, 'https://youtu.be/abc')).toEqual({ error: '[youtube] abc: Private video' })
    const plain = hostRunning({ exitCode: 1, stdout: '', stderr: 'ERROR: Private video' })
    expect(await listPlaylist(plain.h, 'https://youtu.be/abc')).toEqual({ error: 'Private video' })
  })
  test('yt-dlp missing, or output that is not JSON', async () => {
    const h = { run: vi.fn(async () => Promise.reject(new Error('spawn yt-dlp ENOENT'))) } as unknown as Host
    expect(await listPlaylist(h, 'https://x.y/z')).toEqual({ error: "yt-dlp couldn't run: spawn yt-dlp ENOENT" })
    const bad = hostRunning({ exitCode: 0, stdout: 'nope', stderr: '' })
    expect(await listPlaylist(bad.h, 'https://x.y/z')).toEqual({ error: "yt-dlp's listing couldn't be read." })
  })
})
