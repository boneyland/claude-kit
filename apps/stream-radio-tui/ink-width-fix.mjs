// Two fixes to how Ink 5 places characters in its output grid.
//
// Wide characters: Ink takes any character stored as two UTF-16 code units for
// a double-width one. Kitty's image placeholder, U+10EEEE, is two code units
// but one column, so every placeholder cell pushed the text after it a column
// right. Such a character is now wide only if string-width (already imported by
// that file) agrees. Characters of one code unit keep Ink's answer:
// string-width calls ▶ two columns (it can be an emoji), but terminals draw it
// as one.
//
// Zero-width characters: Ink gives every code point a cell, so a combining
// mark (a tag's è spelt e + U+0300) took a column the terminal never draws,
// and the rest of that row came out a column short, tearing the divider and
// the art beside it. A character string-width calls zero columns now joins the
// cell before it, or the start of a double-width character before it.
//
// Applied by build.mjs and vitest.config.ts; package.json pins Ink to 5.2.1,
// the version it was written for, and it throws rather than build a TUI with
// the old code.

const FIXES = [
  {
    old: 'const isWideCharacter = character.fullWidth || character.value.length > 1;',
    new: 'const isWideCharacter = character.fullWidth || (character.value.length > 1 && stringWidth(character.value) > 1);',
  },
  {
    old: 'currentLine[offsetX] = character;',
    new:
      'if (offsetX > x && stringWidth(character.value) === 0) {' +
      ' const before = currentLine[offsetX - 1]?.value === \'\' && offsetX - 2 >= x ? currentLine[offsetX - 2] : currentLine[offsetX - 1];' +
      ' if (before) { before.value += character.value; continue; }' +
      ' }' +
      ' currentLine[offsetX] = character;',
  },
]

export const INK_OUTPUT = /[\\/]ink[\\/]build[\\/]output\.js$/

export function patchInkOutput(source) {
  for (const fix of FIXES) {
    if (source.split(fix.old).length !== 2) throw new Error('ink-width-fix: Ink output.js changed; check the width fixes')
    source = source.replace(fix.old, fix.new)
  }
  return source
}
