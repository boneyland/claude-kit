# session-band

A Claude Code mod: one band above the prompt with the session at a glance.

- **Band**: turn number, a live timer for the running turn, output speed of the last response (tok/s), cost of the last turn and of the session, a countdown of the 1-hour prompt cache since the last answer, the git branch (`*` and amber when the working tree has changes), the current model and effort level, and context fill. The band gets an amber frame 20 minutes before the cache expires and a red one at 10. The row drops details as the window narrows instead of wrapping; `×` hides it for the rest of the session.
- **Spend warnings**: a second row, while idle, when a long context costs more than starting over.
  - *Cache expired*: the next message re-caches the whole context at the 1-hour write price; the row shows that cost next to a new session's.
  - *Overhead*: with the cache warm, every request still reads the whole context. After 3 turns, when the part a new session wouldn't carry costs $0.20 or more per turn, the row shows that cost (priced at the median requests per turn of the last 10 turns, with their mean beside it) and how many turns a new session (and, once a compaction has been measured, `/compact`) takes to pay back. Its `compact, keep N` button compacts the conversation but keeps the last N turns word for word after the summary; `×` hides the row until the context grows another 50k tokens.
  - The baseline a new session starts with is measured: the first request of a fresh session in the project (the smallest of the last 5), or until then `/context`'s breakdown without the conversation. Prices are list prices per model, scaled to match the cost Claude Code reports for the session; a model with no list price waits for that scale. A compaction summary's size is measured from the request after it.
 at 10 and 5 minutes left, a system notification with Claude's icon, titled `<project> — <session title>`, saying how many minutes the cache has left. In the desktop app, clicking it opens the session. Nothing fires while a turn runs.

## The notifier (macOS)

The warning is posted by a small helper app, built once on your Mac (needs Xcode's command line tools; the icon is taken from your installed Claude.app):

```bash
notifier/build.sh
```

It builds `notifier/Session Band.app` next to the script; on its first notification macOS asks whether to allow notifications from "Session Band". Build it in the folder the mod is loaded from, or copy the built app there. Without the helper (or on another OS) the mod falls back to Claude Code's own notification, which also reaches your phone over Remote Control but has no title or click-through; when you are already at the session that one is skipped and a toast says it instead.

## Commands

- `/session_data`: show or hide the band.
- `/session_data compact [turns]`: compact the conversation, keeping the last turns (default: the *Turns kept when compacting* setting, 3) word for word after the summary. Claude Code's own `/compact`, auto-compaction and ahead-of-time compaction are left as they are.
- `/session_data demo <minutes>`: pretend the cache has that many minutes left, to preview the colors and the warning; the next answer resets it.

## Install

At the prompt of a terminal session:

```
/plugin install session-band --marketplace boneyland/session-band
```

From a shell:

```bash
claude plugin install session-band --marketplace boneyland/session-band
```

Type `y` to add the marketplace, then pick a scope.

## Credits

A fork of the `session-band` mod from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit), which added the model and effort display. MIT licensed; see [LICENSE](LICENSE).
