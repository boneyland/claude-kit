// The first row a list shows: `top` once the wheel or a click has placed the
// view, else the window centred on the selected row; never past either end.
export function firstRow(selected: number, count: number, height: number, top?: number): number {
  const last = Math.max(0, count - height)
  return Math.max(0, Math.min(top ?? selected - Math.floor(height / 2), last))
}
