// Ink 5 takes any character stored as two UTF-16 code units for a double-width
// one. Kitty's image placeholder, U+10EEEE, is two code units but one column,
// so every placeholder cell pushed the text after it a column right. Such a
// character is now wide only if string-width (already imported by that file)
// agrees. Characters of one code unit keep Ink's answer: string-width calls ▶
// two columns (it can be an emoji), but terminals draw it as one. Applied by
// build.mjs and vitest.config.ts; package.json pins Ink to 5.2.1, the version
// it was written for, and it throws rather than build a TUI with the old check.

const OLD = 'const isWideCharacter = character.fullWidth || character.value.length > 1;'
const NEW = 'const isWideCharacter = character.fullWidth || (character.value.length > 1 && stringWidth(character.value) > 1);'

export const INK_OUTPUT = /[\\/]ink[\\/]build[\\/]output\.js$/

export function patchInkOutput(source) {
  if (!source.includes(OLD)) throw new Error("ink-width-fix: Ink output.js changed; check the placeholder width fix")
  return source.replace(OLD, NEW)
}
