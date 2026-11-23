// A small PNG encoder for the terminal's pixel crabs. The mod runtime has no
// CompressionStream, so this deflates by itself: fixed Huffman codes and only
// the matches pixel art is made of — a pixel repeated along its row (distance
// 4) and a scanline repeated from the one above (distance one row). An
// upscaled sprite frame comes out at one or two kilobytes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (bytes: Uint8Array, from: number, to: number): number => {
  let c = 0xffffffff
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const adler32 = (bytes: Uint8Array): number => {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

// Deflate's bit stream: values LSB first, Huffman codes MSB first.
class Bits {
  out: number[] = []
  private acc = 0
  private n = 0
  bits(value: number, count: number) {
    for (let i = 0; i < count; i++) {
      this.acc |= ((value >>> i) & 1) << this.n
      if (++this.n === 8) this.flush()
    }
  }
  code(code: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits((code >>> i) & 1, 1)
  }
  flush() {
    if (this.n === 0) return
    this.out.push(this.acc)
    this.acc = 0
    this.n = 0
  }
}

// Fixed Huffman code for a literal/length symbol (RFC 1951 3.2.6).
const litLen = (w: Bits, sym: number) => {
  if (sym < 144) w.code(0x30 + sym, 8)
  else if (sym < 256) w.code(0x190 + sym - 144, 9)
  else if (sym < 280) w.code(sym - 256, 7)
  else w.code(0xc0 + sym - 280, 8)
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

const lastAtMost = (table: number[], v: number): number => {
  let i = 0
  while (i + 1 < table.length && table[i + 1]! <= v) i++
  return i
}

const match = (w: Bits, length: number, distance: number) => {
  const li = lastAtMost(LEN_BASE, length)
  litLen(w, 257 + li)
  w.bits(length - LEN_BASE[li]!, LEN_EXTRA[li]!)
  const di = lastAtMost(DIST_BASE, distance)
  w.code(di, 5)
  w.bits(distance - DIST_BASE[di]!, DIST_EXTRA[di]!)
}

/** zlib stream of `data`, matching only at the given distances. */
export const zlib = (data: Uint8Array, distances: number[]): Uint8Array => {
  const w = new Bits()
  w.bits(1, 1) // final block
  w.bits(1, 2) // fixed Huffman
  let i = 0
  while (i < data.length) {
    let bestLen = 0
    let bestDist = 0
    for (const d of distances) {
      if (d > i || d > 32768) continue
      let len = 0
      while (len < 258 && i + len < data.length && data[i + len] === data[i + len - d]) len++
      if (len > bestLen) {
        bestLen = len
        bestDist = d
      }
    }
    if (bestLen >= 3) {
      match(w, bestLen, bestDist)
      i += bestLen
    } else {
      litLen(w, data[i]!)
      i++
    }
  }
  litLen(w, 256)
  w.flush()
  const sum = adler32(data)
  return Uint8Array.from([0x78, 0x01, ...w.out, sum >>> 24, (sum >>> 16) & 0xff, (sum >>> 8) & 0xff, sum & 0xff])
}

/** A whole PNG of `width * height` RGBA pixels. */
export const encodePng = (rgba: Uint8Array, width: number, height: number): Uint8Array => {
  const stride = width * 4 + 1
  const raw = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1)
  const idat = zlib(raw, [4, stride])

  const chunks: [string, Uint8Array][] = [
    ['IHDR', Uint8Array.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0])],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ]
  const size = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0)
  const png = new Uint8Array(size)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let o = 8
  for (const [type, data] of chunks) {
    png.set(u32(data.length), o)
    for (let k = 0; k < 4; k++) png[o + 4 + k] = type.charCodeAt(k)
    png.set(data, o + 8)
    png.set(u32(crc32(png, o + 4, o + 8 + data.length)), o + 8 + data.length)
    o += 12 + data.length
  }
  return png
}

const u32 = (v: number): number[] => [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
