import fs from 'node:fs/promises'
import { NERD_ICONS } from './ui/icons'

// Whether Termux's font has the controls' Nerd Font icons. Termux draws with
// ~/.termux/font.ttf alone (its own font when there is none), on this device,
// so reading that file answers what no terminal can be asked.
export async function termuxFontHasIcons(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<Uint8Array> = path => fs.readFile(path),
): Promise<boolean> {
  const isTermux = !!env.TERMUX_VERSION || !!env.PREFIX?.includes('/com.termux/')
  if (!isTermux || !env.HOME) return false
  try {
    return hasNerdIcons(await read(`${env.HOME}/.termux/font.ttf`))
  } catch {
    return false
  }
}

const ICON_CODES = Object.values(NERD_ICONS).map(icon => icon.codePointAt(0)!)

// A Nerd Font (by its name: "… Nerd Font …" or "… NF") that maps every icon
// the controls draw. Both, as the icons are private-use codes another font may
// fill with something else, and Nerd Fonts before v3 kept them elsewhere.
// Anything unreadable is no.
export function hasNerdIcons(file: Uint8Array): boolean {
  try {
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    // a collection (.ttc): its first font
    const start = tag(view, 0) === 'ttcf' ? view.getUint32(12) : 0
    const tables = new Map<string, number>()
    for (let i = 0, n = view.getUint16(start + 4); i < n; i++) {
      const at = start + 12 + 16 * i
      tables.set(tag(view, at), view.getUint32(at + 8))
    }
    const cmap = tables.get('cmap')
    const name = tables.get('name')
    if (cmap === undefined || name === undefined) return false
    return isNerdName(familyNames(view, name)) && ICON_CODES.every(code => maps(view, cmap, code))
  } catch {
    return false // read past the end: not a font, or a broken one
  }
}

const tag = (view: DataView, at: number) => String.fromCharCode(...[0, 1, 2, 3].map(i => view.getUint8(at + i)))

const isNerdName = (names: string[]) => names.some(n => /Nerd Font|\bNF\b/.test(n))

// The family and full names (ids 1, 4, 16), Windows (UTF-16BE) and Mac (Roman, read as Latin-1).
function familyNames(view: DataView, table: number): string[] {
  const strings = table + view.getUint16(table + 4)
  const names: string[] = []
  for (let i = 0, n = view.getUint16(table + 2); i < n; i++) {
    const at = table + 6 + 12 * i
    const [platform, id, length, offset] = [view.getUint16(at), view.getUint16(at + 6), view.getUint16(at + 8), view.getUint16(at + 10)]
    if (id !== 1 && id !== 4 && id !== 16) continue
    const bytes = new Uint8Array(view.buffer, view.byteOffset + strings + offset, length)
    if (platform === 3 || platform === 0) {
      let s = ''
      for (let j = 0; j + 1 < length; j += 2) s += String.fromCharCode((bytes[j] << 8) | bytes[j + 1])
      names.push(s)
    } else if (platform === 1) names.push(String.fromCharCode(...bytes))
  }
  return names
}

// Whether a format 12 subtable (the one that reaches past U+FFFF) maps `code`.
function maps(view: DataView, table: number, code: number): boolean {
  for (let i = 0, n = view.getUint16(table + 2); i < n; i++) {
    const sub = table + view.getUint32(table + 4 + 8 * i + 4)
    if (view.getUint16(sub) !== 12) continue
    for (let g = 0, groups = view.getUint32(sub + 12); g < groups; g++) {
      const at = sub + 16 + 12 * g
      const [first, last, glyph] = [view.getUint32(at), view.getUint32(at + 4), view.getUint32(at + 8)]
      if (code >= first && code <= last) return glyph + (code - first) !== 0
    }
  }
  return false
}
