// Fixes to how wide Ink 5 takes text to be: two to how it places characters
// in its output grid (output.js), one to when it measures a text (dom.js).
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
// A text measured again: Ink has Yoga measure a text again when a string in it
// changes, or is added at its end or removed, but not when one is inserted
// before a part already there: insertBeforeNode returns before marking the
// text dirty. The text kept its old width, and truncate-end cut the new one to
// it, so an edit line's first letter showed as … (React makes no node for '',
// so the text before the cursor appeared then, before the cursor's own cell).
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

const DOM_FIXES = [
  {
    old: 'node.yogaNode?.insertChild(newChildNode.yogaNode, index);\n        }\n        return;',
    new:
      'node.yogaNode?.insertChild(newChildNode.yogaNode, index);\n        }\n' +
      "        if (node.nodeName === 'ink-text' || node.nodeName === 'ink-virtual-text') {\n            markNodeAsDirty(node);\n        }\n" +
      '        return;',
  },
]

export const INK_OUTPUT = /[\\/]ink[\\/]build[\\/]output\.js$/
export const INK_DOM = /[\\/]ink[\\/]build[\\/]dom\.js$/

function apply(source, fixes, file) {
  for (const fix of fixes) {
    if (source.split(fix.old).length !== 2) throw new Error(`ink-width-fix: Ink ${file} changed; check the width fixes`)
    source = source.replace(fix.old, fix.new)
  }
  return source
}

export const patchInkOutput = source => apply(source, FIXES, 'output.js')
export const patchInkDom = source => apply(source, DOM_FIXES, 'dom.js')

// Ink's file at `path`, patched if it is one of the two: the build and the tests both load Ink through this.
export const patchInk = (path, source) =>
  INK_OUTPUT.test(path) ? patchInkOutput(source) : INK_DOM.test(path) ? patchInkDom(source) : source
