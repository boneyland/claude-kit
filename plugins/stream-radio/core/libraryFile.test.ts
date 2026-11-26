import { expect, test } from 'claude-code/testing'

import type { Host } from './host'
import { FAVOURITES, markOf, toggle } from './library'
import {
  clearHistory,
  createPlaylist,
  deletePlaylist,
  editPlaylist,
  listMtime,
  listPlaylists,
  NO_LIBRARY,
  GONE,
  readHistory,
  readPlaylist,
  renamePlaylist,
} from './libraryFile'

const LIB = '/lib'

// A Host over files in memory (folders are made by mkdir -p) with a clock that
// sleep moves; run does mkdir, mv, rm and the noclobber create of a lock.
function hostOf(files: Record<string, string> = {}, folder = false) {
  const clock = { now: 1_000_000 }
  const mtimes: Record<string, number> = {}
  const ran: string[][] = []
  let made = folder
  const h = {
    dataDir: async () => '/data',
    libraryDir: async () => LIB,
    now: async () => clock.now,
    sleep: async (ms: number) => void (clock.now += ms),
    log: () => undefined,
    run: async (argv: readonly string[]) => {
      ran.push([...argv])
      if (argv[0] === 'mkdir') made = true
      else if (argv[0] === 'rm') delete files[argv.at(-1)!]
      else if (argv[0] === 'mv') {
        const to = argv.at(-1)!
        const from = argv.at(-2)!
        if (argv.includes('-n') && to in files) return { exitCode: 1, stdout: '', stderr: 'exists' }
        files[to] = files[from]!
        mtimes[to] = clock.now
        delete files[from]
      } else if (argv[0] === 'sh') {
        const path = argv[5]!
        if (path in files) return { exitCode: 1, stdout: '', stderr: 'exists' }
        files[path] = argv[4]!
        mtimes[path] = clock.now
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    fs: {
      exists: async (p: string) => p in files,
      read: async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`)
        return files[p]!
      },
      write: async (p: string, text: string) => {
        files[p] = text
        mtimes[p] = clock.now
      },
      stat: async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`)
        return { kind: 'file', mtimeMs: mtimes[p] ?? 0 }
      },
      list: async (p: string) => {
        if (!made && !Object.keys(files).some(f => f.startsWith(`${p}/`))) throw new Error(`ENOENT: ${p}`)
        return Object.keys(files)
          .filter(f => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/'))
          .map(f => ({ name: f.slice(p.length + 1), kind: 'file' as const }))
      },
    },
  } as unknown as Host
  return { h, files, ran }
}

const song = (path: string) => ({ path, title: path })

test('missing folder lists only Favourites', async () => {
  const { h } = hostOf()
  expect(await listPlaylists(h)).toEqual([{ name: FAVOURITES, file: `${LIB}/${FAVOURITES}.m3u`, count: 0, mtimeMs: 0 }])
  expect(await readPlaylist(h, 'Nope')).toEqual({ lines: [] })
  expect(await listMtime(h, 'Nope')).toBe(0)
})

test('lists Favourites first, then .m3u files by name with their song counts', async () => {
  const { h } = hostOf({
    [`${LIB}/b.m3u`]: '#EXTM3U\n/a.mp3\n/b.mp3\n',
    [`${LIB}/A.m3u`]: '/a.mp3\n',
    [`${LIB}/${FAVOURITES}.m3u`]: '/f.mp3\n',
    [`${LIB}/.hidden.m3u`]: '/x.mp3\n',
    [`${LIB}/c.m3u.1234.tmp`]: '/x.mp3\n',
    [`${LIB}/notes.txt`]: 'x',
  })
  const lists = await listPlaylists(h)
  expect(lists.map(l => [l.name, l.count])).toEqual([[FAVOURITES, 1], ['A', 1], ['b', 2]])
})

test('editPlaylist writes whole and makes the folder', async () => {
  const { h, files, ran } = hostOf()
  const done = await editPlaylist(h, 'Road', f => toggle(f, [song('/a.mp3')], '/h'))
  expect(done).not.toBe('busy')
  expect(ran.some(a => a[0] === 'mkdir' && a.includes(LIB))).toBe(true)
  expect(files[`${LIB}/Road.m3u`]).toBe('#EXTM3U\n#EXTINF:-1,/a.mp3\n/a.mp3\n')
  expect(Object.keys(files).filter(k => k.endsWith('.tmp') || k.endsWith('.lock'))).toEqual([])
})

test('an edit that changes nothing writes nothing', async () => {
  const { h, files } = hostOf()
  await editPlaylist(h, 'Road', f => f)
  expect(`${LIB}/Road.m3u` in files).toBe(false)
})

test('concurrent toggles both land', async () => {
  const { h, files } = hostOf()
  await Promise.all([
    editPlaylist(h, 'Road', f => toggle(f, [song('/a.mp3')], '/h')),
    editPlaylist(h, 'Road', f => toggle(f, [song('/b.mp3')], '/h')),
  ])
  const f = await readPlaylist(h, 'Road')
  expect(markOf(f, [song('/a.mp3'), song('/b.mp3')], '/h')).toBe('all')
  expect(files[`${LIB}/Road.m3u`]).toContain('/b.mp3')
})

test('create, rename and delete', async () => {
  const { h, files } = hostOf()
  expect(await createPlaylist(h, 'Road', [song('/a.mp3')])).toBe('')
  expect(await createPlaylist(h, 'road', [])).toContain('already')
  expect(await createPlaylist(h, 'a/b', [])).not.toBe('')
  expect(await renamePlaylist(h, 'Road', 'Trip')).toBe('')
  expect(Object.keys(files)).toEqual([`${LIB}/Trip.m3u`])
  expect(await deletePlaylist(h, 'Trip')).toBe('')
  expect(Object.keys(files)).toEqual([])
})

test('rename refuses an existing name', async () => {
  const { h, files } = hostOf({ [`${LIB}/A.m3u`]: '/a\n', [`${LIB}/B.m3u`]: '/b\n' })
  expect(await renamePlaylist(h, 'A', 'b')).toContain('already')
  expect(await renamePlaylist(h, 'A', 'history')).toContain('reserved')
  expect(await renamePlaylist(h, 'Nope', 'C')).toContain('no playlist')
  expect(Object.keys(files).sort()).toEqual([`${LIB}/A.m3u`, `${LIB}/B.m3u`])
})

test('a rename that changes only case works where the file system ignores case', async () => {
  const { h, files } = hostOf({ [`${LIB}/Rock.m3u`]: '#EXTM3U\n/a.mp3\n' })
  // like macOS: mv -n onto a name that differs only in case does nothing and exits 0
  const run = h.run.bind(h)
  const insensitive = {
    ...h,
    run: async (argv: readonly string[], o?: unknown) => {
      if (argv[0] === 'mv' && argv.includes('-n')) {
        const to = argv.at(-1)!.toLowerCase()
        if (Object.keys(files).some(f => f.toLowerCase() === to)) return { exitCode: 0, stdout: '', stderr: '' }
      }
      return run(argv as string[], o as never)
    },
  } as Host
  expect(await renamePlaylist(insensitive, 'Rock', 'rock')).toBe('')
  expect(Object.keys(files)).toEqual([`${LIB}/rock.m3u`])
})

test('a rename mv quietly skips is reported, not taken as done', async () => {
  const { h } = hostOf({ [`${LIB}/A.m3u`]: '#EXTM3U\n' })
  const still = { ...h, run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } as unknown as Host
  expect(await renamePlaylist(still, 'A', 'B')).toMatch(/Could not rename/)
})

test('with no library folder nothing is written and edits say why', async () => {
  const { h, ran } = hostOf()
  const nowhere = { ...h, libraryDir: async () => '' } as Host
  expect(await listPlaylists(nowhere)).toEqual([])
  expect(await editPlaylist(nowhere, FAVOURITES, f => toggle(f, [song('/a.mp3')], ''))).toBe(NO_LIBRARY)
  expect(await createPlaylist(nowhere, 'A', [])).toBe(NO_LIBRARY)
  expect(await renamePlaylist(nowhere, 'A', 'B')).toBe(NO_LIBRARY)
  expect(await deletePlaylist(nowhere, 'A')).toBe(NO_LIBRARY)
  expect(ran).toEqual([])
})

test('an edit that must find the list does not make a deleted one again', async () => {
  const { h, files } = hostOf({}, true)
  expect(await editPlaylist(h, 'Road', f => toggle(f, [song('/a.mp3')], ''), { mustExist: true })).toBe(GONE)
  expect(Object.keys(files).filter(f => f.endsWith('.m3u'))).toEqual([])
})

test('delete and rename refuse Favourites', async () => {
  const { h, files } = hostOf({ [`${LIB}/${FAVOURITES}.m3u`]: '/a\n' })
  expect(await deletePlaylist(h, FAVOURITES)).not.toBe('')
  expect(await renamePlaylist(h, FAVOURITES, 'X')).not.toBe('')
  expect(Object.keys(files)).toEqual([`${LIB}/${FAVOURITES}.m3u`])
})

test('history skips broken lines, newest first; missing file is empty', async () => {
  expect(await readHistory(hostOf().h)).toEqual([])
  const { h } = hostOf({
    '/data/history.jsonl': '{"at":1,"path":"/a","title":"A"}\nnot json\n\n{"at":2,"path":"/b","title":"B"}\n',
  })
  expect((await readHistory(h)).map(p => p.path)).toEqual(['/b', '/a'])
})

test('clearHistory empties', async () => {
  const { h, files } = hostOf({ '/data/history.jsonl': '{"at":1,"path":"/a","title":"A"}\n' })
  await clearHistory(h)
  expect(files['/data/history.jsonl']).toBe('')
  expect(await readHistory(h)).toEqual([])
})
