import { expect, test } from 'claude-code/testing'

import { expandSource, MAX_SONGS } from './expand'
import type { Host } from './host'

type Kind = 'file' | 'dir' | 'other'

// A Host over a fake tree (folder -> entries, file -> text) and a fake run that
// records argv and answers curl / yt-dlp from `replies`.
function hostOf(opts: { dirs?: Record<string, { name: string; kind: Kind }[]>; files?: Record<string, string>; curl?: string; ytdlp?: string }) {
  const runs: (readonly string[])[] = []
  const dirs = opts.dirs ?? {}
  const files = opts.files ?? {}
  const h = {
    fs: {
      list: async (p: string) => dirs[p] ?? [],
      read: async (p: string) => {
        if (p in files) return files[p]
        throw new Error('ENOENT')
      },
      stat: async (p: string) => {
        if (p in dirs) return { kind: 'dir' as const, mtimeMs: 0 }
        if (p in files) return { kind: 'file' as const, mtimeMs: 0 }
        throw new Error('ENOENT')
      },
      exists: async (p: string) => p in dirs || p in files,
    },
    run: async (argv: readonly string[]) => {
      runs.push(argv)
      if (argv[0] === 'curl') return { exitCode: opts.curl === undefined ? 22 : 0, stdout: opts.curl ?? '', stderr: '' }
      if (argv[0] === 'yt-dlp') return { exitCode: 0, stdout: opts.ytdlp ?? '{}', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  } as unknown as Host
  return { h, runs }
}

const f = (name: string) => ({ name, kind: 'file' as const })

test('a folder expands in name order, capped', async () => {
  const { h } = hostOf({ dirs: { '/m': [f('b.mp3'), f('a.mp3'), f('.hid.mp3'), f('cover.jpg'), f('c.mp3')] } })
  const all = await expandSource(h, '/m')
  expect(all.entries.map(e => e.path)).toEqual(['/m/a.mp3', '/m/b.mp3', '/m/c.mp3'])
  expect(all.root).toBe('/m')
  expect(all.note).toBe('')
  const some = await expandSource(h, '/m', 2)
  expect(some.entries.map(e => e.path)).toEqual(['/m/a.mp3', '/m/b.mp3'])
  expect(some.note).toBe('Added the first 2 songs of /m.')
  expect(MAX_SONGS).toBe(10_000)
})

test('m3u lines, titles and relative paths', async () => {
  const { h } = hostOf({ files: { '/pl/x.m3u': '#EXTM3U\n#EXTINF:123,Nice One\nsub/a.mp3\n\n# comment\n/abs/b.flac\nhttp://r.example/s\n' } })
  const r = await expandSource(h, '/pl/x.m3u')
  expect(r.entries).toEqual([{ path: '/pl/sub/a.mp3', title: 'Nice One' }, { path: '/abs/b.flac' }, { path: 'http://r.example/s' }])
  expect(r.root).toBe('')
})

test('pls File1/Title1', async () => {
  const { h } = hostOf({ files: { '/pl/x.pls': '[playlist]\nFile1=a.mp3\nTitle1=First\nFile2=/z/b.mp3\nNumberOfEntries=2\n' } })
  expect((await expandSource(h, '/pl/x.pls')).entries).toEqual([{ path: '/pl/a.mp3', title: 'First' }, { path: '/z/b.mp3' }])
})

test('a folder line in an m3u expands', async () => {
  const { h } = hostOf({ dirs: { '/pl/album': [f('2.mp3'), f('1.mp3')] }, files: { '/pl/x.m3u': 'album\nsolo.mp3\n' } })
  expect((await expandSource(h, '/pl/x.m3u')).entries.map(e => e.path)).toEqual(['/pl/album/1.mp3', '/pl/album/2.mp3', '/pl/solo.mp3'])
})

test('a nested m3u expands, to depth 3', async () => {
  const files: Record<string, string> = { '/p/0.m3u': '1.m3u\n', '/p/1.m3u': '2.m3u\n', '/p/2.m3u': '3.m3u\n', '/p/3.m3u': 'deep.mp3\n', '/p/n.m3u': 'a.mp3\nin.m3u\n', '/p/in.m3u': 'b.mp3\n' }
  const { h } = hostOf({ files })
  expect((await expandSource(h, '/p/n.m3u')).entries.map(e => e.path)).toEqual(['/p/a.mp3', '/p/b.mp3'])
  expect((await expandSource(h, '/p/0.m3u')).entries.map(e => e.path)).not.toContain('/p/deep.mp3')
})

test('an unreadable playlist file says so', async () => {
  const { h } = hostOf({})
  const r = await expandSource(h, '/gone.m3u')
  expect(r.entries).toEqual([])
  expect(r.note).toContain('/gone.m3u')
})

test('a remote pls is fetched with limits', async () => {
  const { h, runs } = hostOf({ curl: '[playlist]\nFile1=http://s.example/live\nTitle1=Live\n' })
  const r = await expandSource(h, 'http://x.example/a/r.pls')
  expect(runs[0].slice(0, 6)).toEqual(['curl', '-fsSL', '--max-filesize', '1048576', '--max-time', '10'])
  expect(r.entries).toEqual([{ path: 'http://s.example/live', title: 'Live' }])
})

test('a remote m3u resolves relative lines against its URL', async () => {
  const { h } = hostOf({ curl: '#EXTM3U\nsongs/a.mp3\n' })
  expect((await expandSource(h, 'http://x.example/a/r.m3u')).entries).toEqual([{ path: 'http://x.example/a/songs/a.mp3' }])
})

test('m3u8 stays one entry', async () => {
  const { h, runs } = hostOf({})
  const r = await expandSource(h, 'https://x.example/live/index.m3u8?t=1')
  expect(r.entries).toEqual([{ path: 'https://x.example/live/index.m3u8?t=1' }])
  expect(runs).toEqual([])
})

test('HLS content stays one entry', async () => {
  const { h } = hostOf({ curl: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n' })
  const r = await expandSource(h, 'https://x.example/radio.m3u')
  expect(r.entries).toEqual([{ path: 'https://x.example/radio.m3u' }])
})

test('a YouTube playlist lists its videos', async () => {
  const out = { title: 'Mix', entries: [{ url: 'https://www.youtube.com/watch?v=a', title: 'First' }, { title: 'Gone' }] }
  const { h, runs } = hostOf({ ytdlp: JSON.stringify(out) })
  const r = await expandSource(h, 'https://www.youtube.com/playlist?list=PL1')
  expect(r.entries).toEqual([{ path: 'https://www.youtube.com/watch?v=a', title: 'First' }])
  expect(runs[0][0]).toBe('yt-dlp')
})

test('a plain stream does not wait on yt-dlp', async () => {
  const { h, runs } = hostOf({})
  expect((await expandSource(h, 'https://radio.example/stream')).entries).toEqual([{ path: 'https://radio.example/stream' }])
  expect(runs).toEqual([])
})

test('a .cue and a plain file stay one entry', async () => {
  const { h } = hostOf({ files: { '/a/x.cue': 'FILE', '/a/s.mp3': '' } })
  expect((await expandSource(h, '/a/x.cue')).entries).toEqual([{ path: '/a/x.cue' }])
  expect((await expandSource(h, '/a/s.mp3')).entries).toEqual([{ path: '/a/s.mp3' }])
})
