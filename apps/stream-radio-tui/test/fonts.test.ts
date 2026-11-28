import { describe, expect, test } from 'vitest'
import { hasNerdIcons, termuxFontHasIcons } from '../src/fonts'
import { NERD_ICONS } from '../src/ui/icons'

// A font file with only what hasNerdIcons reads: a cmap (format 12 groups,
// one per code) and a name table with `family` (Windows, UTF-16BE).
function sfnt(family: string, codes: number[]): Buffer {
  const cmap = (() => {
    const groups = codes.map((c, i) => [c, c, i + 1])
    const sub = Buffer.alloc(16 + 12 * groups.length)
    sub.writeUInt16BE(12, 0)
    sub.writeUInt32BE(sub.length, 4)
    sub.writeUInt32BE(groups.length, 12)
    groups.forEach(([s, e, g], i) => {
      sub.writeUInt32BE(s, 16 + 12 * i)
      sub.writeUInt32BE(e, 20 + 12 * i)
      sub.writeUInt32BE(g, 24 + 12 * i)
    })
    const head = Buffer.alloc(12)
    head.writeUInt16BE(1, 2)
    head.writeUInt16BE(3, 4)
    head.writeUInt16BE(10, 6)
    head.writeUInt32BE(12, 8)
    return Buffer.concat([head, sub])
  })()
  const name = (() => {
    const text = Buffer.from(family, 'utf16le').swap16()
    const head = Buffer.alloc(6 + 12)
    head.writeUInt16BE(1, 2)
    head.writeUInt16BE(18, 4)
    head.writeUInt16BE(3, 6)
    head.writeUInt16BE(1, 8)
    head.writeUInt16BE(0x409, 10)
    head.writeUInt16BE(1, 12)
    head.writeUInt16BE(text.length, 14)
    return Buffer.concat([head, text])
  })()
  const tables: [string, Buffer][] = [
    ['cmap', cmap],
    ['name', name],
  ]
  const dir = Buffer.alloc(12 + 16 * tables.length)
  dir.writeUInt32BE(0x00010000, 0)
  dir.writeUInt16BE(tables.length, 4)
  let offset = dir.length
  tables.forEach(([tag, data], i) => {
    dir.write(tag, 12 + 16 * i, 'latin1')
    dir.writeUInt32BE(offset, 20 + 16 * i)
    dir.writeUInt32BE(data.length, 24 + 16 * i)
    offset += data.length
  })
  return Buffer.concat([dir, ...tables.map(([, data]) => data)])
}

const ICON_CODES = Object.values(NERD_ICONS).map(icon => icon.codePointAt(0)!)

describe('hasNerdIcons', () => {
  test('a Nerd Font with the icons the controls draw', () => {
    expect(hasNerdIcons(sfnt('JetBrainsMono Nerd Font Mono', [0x41, ...ICON_CODES]))).toBe(true)
    expect(hasNerdIcons(sfnt('Cascadia Mono NF', ICON_CODES))).toBe(true)
  })
  test('another font with glyphs at those codes is not one (they are private use)', () => {
    expect(hasNerdIcons(sfnt('Unifont CSUR', ICON_CODES))).toBe(false)
  })
  test('a Nerd Font without them (v2 put Material icons elsewhere) is not enough', () => {
    expect(hasNerdIcons(sfnt('Hack Nerd Font', [0x41, 0xf500, ...ICON_CODES.slice(1)]))).toBe(false)
  })
  test('the first font of a collection counts', () => {
    const font = sfnt('Iosevka Nerd Font', ICON_CODES)
    const head = Buffer.alloc(16)
    head.write('ttcf', 0, 'latin1')
    head.writeUInt32BE(0x00010000, 4)
    head.writeUInt32BE(1, 8)
    head.writeUInt32BE(16, 12)
    // table offsets are from the file's start, so shift them past the header
    const shifted = Buffer.from(font)
    for (let i = 0; i < shifted.readUInt16BE(4); i++) shifted.writeUInt32BE(shifted.readUInt32BE(20 + 16 * i) + 16, 20 + 16 * i)
    expect(hasNerdIcons(Buffer.concat([head, shifted]))).toBe(true)
  })
  test('anything else is no, without throwing', () => {
    expect(hasNerdIcons(Buffer.alloc(0))).toBe(false)
    expect(hasNerdIcons(Buffer.from('not a font at all, just some text'))).toBe(false)
    expect(hasNerdIcons(sfnt('JetBrainsMono Nerd Font Mono', ICON_CODES).subarray(0, 40))).toBe(false)
  })
})

describe('termuxFontHasIcons', () => {
  const font = sfnt('JetBrainsMono Nerd Font Mono', ICON_CODES)
  test('in Termux, reads ~/.termux/font.ttf', async () => {
    const asked: string[] = []
    const read = async (path: string) => (asked.push(path), font)
    expect(await termuxFontHasIcons({ TERMUX_VERSION: '0.118.1', HOME: '/data/home' }, read)).toBe(true)
    expect(asked).toEqual(['/data/home/.termux/font.ttf'])
  })
  test('outside Termux nothing is read', async () => {
    const read = async () => {
      throw new Error('read')
    }
    expect(await termuxFontHasIcons({ HOME: '/home/yh' }, read)).toBe(false)
  })
  test('no font file (Termux\'s own font) is no', async () => {
    const read = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    expect(await termuxFontHasIcons({ TERMUX_VERSION: '0.118.1', HOME: '/data/home' }, read)).toBe(false)
  })
})
