import { describe, expect, test } from 'vitest'
import type { Host } from '@core/host'
import { fileRows, type FileEntry, type Listing } from '../src/files/tree'
import { loadFolder } from '../src/files/load'
import { lastFolder, rememberFolder } from '../src/files/remember'

const dir = (path: string, mtimeMs = 0): FileEntry => ({ path, name: path.split('/').pop()!, kind: 'dir', mtimeMs })
const file = (path: string, mtimeMs = 0): FileEntry => ({ path, name: path.split('/').pop()!, kind: 'file', mtimeMs })
const none = () => undefined

describe('fileRows', () => {
  test('../ comes first, even in an empty folder', () => {
    expect(fileRows('/m', new Map([['/m', []]]), new Set(), 'name', none)).toEqual([{ kind: 'up' }])
  })
  test('folders first by name, then files; an open folder shows its rows under it', () => {
    const listings = new Map<string, Listing>([
      ['/m', [file('/m/b.mp3'), dir('/m/Z'), file('/m/a.mp3'), dir('/m/10'), dir('/m/2')]],
      ['/m/2', [file('/m/2/x.flac')]],
    ])
    expect(fileRows('/m', listings, new Set(['/m/2']), 'name', none)).toEqual([
      { kind: 'up' },
      { kind: 'dir', path: '/m/2', name: '2', depth: 0, isOpen: true },
      { kind: 'file', path: '/m/2/x.flac', name: 'x.flac', depth: 1 },
      { kind: 'dir', path: '/m/10', name: '10', depth: 0, isOpen: false },
      { kind: 'dir', path: '/m/Z', name: 'Z', depth: 0, isOpen: false },
      { kind: 'file', path: '/m/a.mp3', name: 'a.mp3', depth: 0 },
      { kind: 'file', path: '/m/b.mp3', name: 'b.mp3', depth: 0 },
    ])
  })
  test('modified: newest file first; folders still first by name', () => {
    const listings = new Map<string, Listing>([['/m', [file('/m/old.mp3', 1), dir('/m/B', 9), file('/m/new.mp3', 5), dir('/m/A', 1)]]])
    expect(fileRows('/m', listings, new Set(), 'modified', none).map(r => ('name' in r ? r.name : r.kind))).toEqual(['up', 'A', 'B', 'new.mp3', 'old.mp3'])
  })
  test('artist: by tag, untagged last, then by name', () => {
    const listings = new Map<string, Listing>([['/m', [file('/m/a.mp3'), file('/m/b.mp3'), file('/m/c.mp3')]]])
    const tags = (p: string) => (p === '/m/c.mp3' ? { title: '', artist: 'Abba', albumArtist: '', album: '' } : undefined)
    expect(fileRows('/m', listings, new Set(), 'artist', tags).map(r => ('name' in r ? r.name : r.kind))).toEqual(['up', 'c.mp3', 'a.mp3', 'b.mp3'])
  })
  test('a folder still loading shows loading… under it; an error shows its text', () => {
    const listings = new Map<string, Listing>([
      ['/m', [dir('/m/A'), dir('/m/B')]],
      ['/m/A', 'loading'],
      ['/m/B', { error: 'Permission denied' }],
    ])
    expect(fileRows('/m', listings, new Set(['/m/A', '/m/B']), 'name', none)).toEqual([
      { kind: 'up' },
      { kind: 'dir', path: '/m/A', name: 'A', depth: 0, isOpen: true },
      { kind: 'note', text: 'loading…', depth: 1 },
      { kind: 'dir', path: '/m/B', name: 'B', depth: 0, isOpen: true },
      { kind: 'note', text: 'Permission denied', depth: 1 },
    ])
  })
  test('the root itself loading', () => {
    expect(fileRows('/m', new Map([['/m', 'loading']]), new Set(), 'name', none)).toEqual([{ kind: 'up' }, { kind: 'note', text: 'loading…', depth: 0 }])
  })
})

const fakeHost = (tree: Record<string, { name: string; kind: 'file' | 'dir' | 'other' }[]>, files: Record<string, string> = {}) =>
  ({
    fs: {
      list: async (p: string) => {
        if (!tree[p]) throw new Error(`ENOENT: ${p}`)
        return tree[p]
      },
      stat: async (p: string) => ({ kind: tree[p] ? 'dir' : 'file', mtimeMs: p.length }),
      read: async (p: string) => {
        if (!(p in files)) throw new Error('ENOENT')
        return files[p]
      },
      write: async (p: string, text: string) => void (files[p] = text),
      exists: async (p: string) => p in files || p in tree,
    },
    dataDir: async () => '/state',
    libraryDir: async () => '/lib',
  }) as unknown as Host

describe('loadFolder', () => {
  test('folders and playable files; no dotfiles, nothing else', async () => {
    const h = fakeHost({ '/m': [{ name: 'a.mp3', kind: 'file' }, { name: 'cover.jpg', kind: 'file' }, { name: '.git', kind: 'dir' }, { name: 'A', kind: 'dir' }, { name: '.x.mp3', kind: 'file' }] })
    const got = await loadFolder(h, '/m')
    expect(got.map(e => [e.name, e.kind])).toEqual([['a.mp3', 'file'], ['A', 'dir']])
    expect(got[0]).toMatchObject({ path: '/m/a.mp3', mtimeMs: '/m/a.mp3'.length })
  })
})

describe('loadFolder and links', () => {
  test('a symlink is kept as what it points to: a folder, or a playable file; a broken one is dropped', async () => {
    const h = {
      fs: {
        list: async () => [
          { name: 'Linked', kind: 'other' },
          { name: 'song.mp3', kind: 'other' },
          { name: 'notes.txt', kind: 'other' },
          { name: 'broken.mp3', kind: 'other' },
        ],
        stat: async (p: string) => {
          if (p === '/m/Linked') return { kind: 'dir', mtimeMs: 3 }
          if (p === '/m/song.mp3' || p === '/m/notes.txt') return { kind: 'file', mtimeMs: 4 }
          throw new Error('ENOENT')
        },
      },
    } as unknown as Host
    const got = await loadFolder(h, '/m')
    expect(got.map(e => [e.name, e.kind])).toEqual([['Linked', 'dir'], ['song.mp3', 'file']])
  })
})

describe('fileRows keeps a playlist in its order', () => {
  test('files of a folder in `ordered` keep the listing order, whatever the sort', () => {
    const listings = new Map<string, Listing>([['/p', [file('/p/zed'), file('/p/alpha'), file('/p/mid')]]])
    const names = (sort: 'name' | 'modified') => fileRows('/p', listings, new Set(), sort, none, new Set(['/p'])).map(r => ('name' in r ? r.name : r.kind))
    expect(names('name')).toEqual(['up', 'zed', 'alpha', 'mid'])
    expect(names('modified')).toEqual(['up', 'zed', 'alpha', 'mid'])
  })
})

describe('remember', () => {
  test('the last folder is kept in the data folder', async () => {
    const files: Record<string, string> = {}
    const h = fakeHost({}, files)
    expect(await lastFolder(h)).toBe('')
    await rememberFolder(h, '/m/A')
    expect(JSON.parse(files['/state/tui-files.json'])).toEqual({ folder: '/m/A' })
    expect(await lastFolder(h)).toBe('/m/A')
  })
})
