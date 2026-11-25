import React from 'react'
import { Text as InkText, type TextProps } from 'ink'

// C0 and C1 control characters, ESC among them. Ink passes them through to the
// terminal, so a song's tags, a file's name or a video's title could carry an
// escape sequence: OSC 52, which sets the clipboard, or one that asks the
// terminal to answer into stdin.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

// `text` without control characters; a line break or tab becomes a space.
export const clean = (text: string): string => text.replace(/[\t\n\r]/g, ' ').replace(CONTROL, '')

const cleaned = (node: React.ReactNode): React.ReactNode =>
  typeof node === 'string' ? clean(node) : Array.isArray(node) ? node.map(cleaned) : node

// Ink's Text, its strings cleaned: what every part of the screen draws text with.
export function Text({ children, ...props }: TextProps) {
  return <InkText {...props}>{cleaned(children)}</InkText>
}

// Ink's own Text, for strings that carry escape sequences on purpose: the
// placeholder cells that show kitty pictures.
export const RawText = InkText
