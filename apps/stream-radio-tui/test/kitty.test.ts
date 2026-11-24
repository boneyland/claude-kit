import { describe, expect, test } from 'vitest'
import { inflateSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { deleteImage, placeholderRow, placeVirtual, transmitRgba } from '../src/gfx/kitty'

const P = '\u{10EEEE}'
const ESC_RE = /\x1b_G([^;]*);?([^\x1b]*)\x1b\\/g

// [header, payload] of each escape in `s`
const escapes = (s: string) => [...s.matchAll(ESC_RE)].map(m => [m[1], m[2]] as const)

describe('kitty', () => {
  test('a virtual placement for one image row', () => {
    expect(placeVirtual(7, 30, 1)).toBe('\x1b_Ga=p,U=1,q=2,i=7,c=30,r=1\x1b\\')
  })

  test('deleting an image frees its data too', () => {
    expect(deleteImage(7)).toBe('\x1b_Ga=d,d=I,q=2,i=7\x1b\\')
  })

  test('a placeholder row carries the image id as its foreground colour', () => {
    expect(placeholderRow(0x010203, 3)).toBe(`\x1b[38;2;1;2;3m${P}${P}${P}\x1b[39m`)
  })

  test('a large image goes in chunks of at most 4096, and inflates back to the pixels', () => {
    const rgba = new Uint8Array(randomBytes(100 * 100 * 4))
    const parts = escapes(transmitRgba(9, 100, 100, rgba))
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0][0]).toBe('a=t,q=2,f=32,o=z,s=100,v=100,i=9,m=1')
    for (const [header] of parts.slice(1, -1)) expect(header).toBe('m=1')
    expect(parts.at(-1)![0]).toBe('m=0')
    for (const [, payload] of parts) expect(payload.length).toBeLessThanOrEqual(4096)
    const joined = Buffer.from(parts.map(p => p[1]).join(''), 'base64')
    expect(new Uint8Array(inflateSync(joined))).toEqual(rgba)
  })

  test('a small image is one escape that says it is the last', () => {
    const parts = escapes(transmitRgba(1, 1, 1, new Uint8Array([1, 2, 3, 4])))
    expect(parts).toHaveLength(1)
    expect(parts[0][0]).toBe('a=t,q=2,f=32,o=z,s=1,v=1,i=1,m=0')
  })
})
