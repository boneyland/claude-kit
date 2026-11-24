// By hand, in kitty: does a picture drawn as one image per row, with bare
// placeholder cells (no diacritics), line up? Run from apps/stream-radio-tui:
//
//   npx esbuild test/manual/kitty-check.ts --bundle --platform=node --format=esm \
//     --outfile="$TMPDIR/kitty-check.mjs" && node "$TMPDIR/kitty-check.mjs"
//
// Pass: one unbroken picture 24 columns wide (a gradient, a white border, a
// diagonal line), `|end` right after it on every line, no gaps between rows
// wider than a hairline.

import { deleteImage, placeholderRow, placeVirtual, transmitRgba } from '../../src/gfx/kitty'

const W = 240
const H = 120
const ROWS = 6
const COLS = 24

const picture = new Uint8Array(W * H * 4)
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    const isEdge = x === 0 || y === 0 || x === W - 1 || y === H - 1
    const isLine = Math.abs(x - Math.round((y * (W - 1)) / (H - 1))) <= 1
    const v = isEdge || isLine ? 255 : 0
    picture.set([isEdge || isLine ? v : Math.round((x / W) * 255), isEdge || isLine ? v : Math.round((y / H) * 255), isEdge || isLine ? v : 160, 255], i)
  }

const strip = H / ROWS
let out = ''
for (let r = 0; r < ROWS; r++) {
  const id = r + 1
  out += transmitRgba(id, W, strip, picture.subarray(r * strip * W * 4, (r + 1) * strip * W * 4)) + placeVirtual(id, COLS, 1)
}
process.stdout.write(out)
for (let r = 0; r < ROWS; r++) process.stdout.write(`${placeholderRow(r + 1, COLS)}|end\n`)
process.stdout.write('\nPress Enter to clean up.')
process.stdin.once('data', () => {
  for (let r = 0; r < ROWS; r++) process.stdout.write(deleteImage(r + 1))
  process.stdout.write('\n')
  process.exit(0)
})
