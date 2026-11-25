import { deflateSync } from 'node:zlib'

// The Kitty graphics protocol, as this TUI uses it: images are sent once and
// given a virtual placement (U=1), and the screen shows them through
// placeholder cells, U+10EEEE, in the text Ink draws. Each image is one row of
// cells; cells carry no diacritics, so kitty counts the columns itself (Ink
// would give each combining mark a column of its own). q=2: no replies.

const PLACEHOLDER = '\u{10EEEE}'
const CHUNK = 4096

// The ids each part of the screen draws with.
export const ART_IDS = { first: 1, last: 200 }
export const WAVE_IDS = { first: 201, last: 210 }

const apc = (control: string, payload = '') => `\x1b_G${control}${payload ? `;${payload}` : ''}\x1b\\`

// `rgba` (width × height × 4 bytes), compressed and sent as image `id`.
export function transmitRgba(id: number, width: number, height: number, rgba: Uint8Array): string {
  return transmitDeflated(id, width, height, deflateSync(rgba))
}

// The same, from pixels already deflated (as screen.ts does off the main thread).
export function transmitDeflated(id: number, width: number, height: number, deflated: Uint8Array): string {
  const data = Buffer.from(deflated.buffer, deflated.byteOffset, deflated.byteLength).toString('base64')
  const chunks: string[] = []
  for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.slice(i, i + CHUNK))
  if (chunks.length === 0) chunks.push('')
  return chunks
    .map((chunk, i) => {
      const more = i < chunks.length - 1 ? 1 : 0
      return i === 0 ? apc(`a=t,q=2,f=32,o=z,s=${width},v=${height},i=${id},m=${more}`, chunk) : apc(`m=${more}`, chunk)
    })
    .join('')
}

// Image `id` shown wherever its placeholder cells are, scaled to cols × rows cells.
export const placeVirtual = (id: number, cols: number, rows: number): string => apc(`a=p,U=1,q=2,i=${id},c=${cols},r=${rows}`)

// Image `id` and its data gone.
export const deleteImage = (id: number): string => apc(`a=d,d=I,q=2,i=${id}`)

// `cols` placeholder cells of image `id`. The id rides in the foreground
// colour, written as raw SGR so no colour-depth guess can round it.
export function placeholderRow(id: number, cols: number): string {
  const [r, g, b] = [(id >> 16) & 255, (id >> 8) & 255, id & 255]
  return `\x1b[38;2;${r};${g};${b}m${PLACEHOLDER.repeat(cols)}\x1b[39m`
}
