# turn-gauge

A Claude Code mod: one band above the prompt with the session at a glance.

See the [manual](MANUAL.md) for what each part shows, when the warnings and the compact button appear, and how costs are worked out.

- **Band**: turn number, output speed of the last response (tok/s), cost of the last turn with its subagents' part (beside the median and mean of the last 10 turns) and of the session, a countdown of the 1-hour prompt cache since the last answer, the current model and effort level, context fill, the last turn's cache hit rate, and the session's input and output tokens. The band gets an amber frame 20 minutes before the cache expires and a red one at 10. The row measures itself and drops details to fit the window, in the terminal and the desktop app, instead of wrapping or running off the edge; `×` hides it for the rest of the session.
- **Pace projection**: where each plan window ends at the current pace, as a heads-up row when you're on track to run out before it resets ("Heads up: weekly limit runs out Mon 14:21, 20h before reset"). The pace is exponentially smoothed; after two finished weeks the weekly forecast follows your learned hour-of-week pattern. `/turn-gauge pace` scores these against a straight line and last window's use, against how each window really ended.
- **Spend warnings**: a second row, while idle, when something costs more than it should.
  - *Cache miss*: the last turn re-wrote 20k+ tokens of context the cache should have held, for no reason the band knows of (not an expiry, compaction, model switch or new session). Usually a tool, MCP, CLAUDE.md or plugin change.
  - *Output-heavy turn*: the last turn wrote 30k+ output tokens and they made up 40%+ of its cost; the row shows what they cost.
  - *Cache expired*: the next turn rewrites the whole context at the 1-hour write price; the row shows that cost next to a new session's.
  - *Overhead*: with the cache warm, every request still reads the whole context. After 3 turns, when re-reading the part a new session wouldn't carry comes to 60% or more of a typical turn's cost (and at least $0.05), the row shows that carry cost (priced at the median requests per turn of the last 10 turns) next to what a new session (and, once a compaction has been measured, `/compact`) costs once, and how many turns it takes to pay back. A new session's cost includes re-reading what it needs in its first turns (the warm-up): measured per project, guessed until then. Its `compact, keep N` button compacts the conversation but keeps the last N turns word for word after the summary; `×` hides the row until the context grows another 50k tokens.
  - The baseline a new session starts with is measured: the first request of a fresh session in the project (the smallest of the last 5), or until then `/context`'s breakdown without the conversation. Prices are list prices per model, scaled to match the cost Claude Code reports for the session; a model with no list price waits for that scale. A compaction summary's size is measured from the request after it. The warm-up is what a fresh session's context grew by over its first 2 turns (configurable, 1–3), the median of the last 5 in the project.
- **Cache notification**: at 10 and 5 minutes left, a system notification with Claude's icon, titled `<project> — <session title>`, saying how many minutes the cache has left. In the desktop app, clicking it opens the session. Nothing fires while a turn runs.

## The notifier (macOS)

The warning is posted by a small helper app, built once on your Mac (needs Xcode's command line tools; the icon is taken from your installed Claude.app):

```bash
plugins/turn-gauge/notifier/build.sh
```

It builds `notifier/Turn Gauge.app` next to the script; on its first notification macOS asks whether to allow notifications from "Turn Gauge". Build it in the folder the mod is loaded from, or copy the built app there. Without the helper (or on another OS) the mod falls back to Claude Code's own notification, which also reaches your phone over Remote Control but has no title or click-through; when you are already at the session that one is skipped and a toast says it instead.

## What it runs, reads and sends

- **Programs**: on macOS, if you built it, `notifier/Turn Gauge.app` posts the cache notification.
- **Network**: none. Nothing leaves your machine. Without the notifier it falls back to Claude Code's own `PushNotification`, which Remote Control may forward to your phone.
- **Files**: in the desktop app on macOS, the session's title from Claude's own session record (`~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>/<session>.json`), for the notification's title. Its own state (spend history, the learned weekly pace, dismissed warnings) stays in the plugin's store (`$.store`) on this machine.
- **Environment**: `CLAUDE_CODE_HOST_SESSION_ID`, to know it runs in the desktop app and which session, and to name the band's saved figures for that session in its store; `CLAUDE_CODE_ACCOUNT_UUID` and `CLAUDE_CODE_ORGANIZATION_UUID`, only to build the path of that session record above; `HOME`. None of them leaves your machine.
- **Other plugins**: if the Cache mod is installed, its `expiresAt` state, read only to restore the cache countdown after a plugin reload missed the end of a turn.
- **Conversation**: token counts, costs and timings of the session and its subagents, as Claude Code reports them; never the text of your prompts or Claude's answers. `/turn-gauge compact` and the compact button ask Claude Code to compact the conversation, only when you click or run them.

## Commands

- `/turn-gauge`: show or hide the band.
- `/turn-gauge compact [turns]`: compact the conversation, keeping the last turns (default: the *Turns kept when compacting* setting, 3) word for word after the summary. Claude Code's own `/compact`, auto-compaction and ahead-of-time compaction are left as they are.
- `/turn-gauge pace`: where the 5-hour and weekly windows end at this pace, and how accurate past projections were.
- `/turn-gauge demo <minutes>`: pretend the cache has that many minutes left, to preview the colors and the warning; the next answer resets it.

## Install

At the prompt of a terminal session:

```
/plugin marketplace add boneyland/claude-kit
/plugin install turn-gauge@claude-kit
```

From a shell:

```bash
claude plugin marketplace add boneyland/claude-kit
claude plugin install turn-gauge@claude-kit
```

## Credits

Started as a fork of johnnyvizz's `session-band` mod in [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit), renamed turn-gauge when it grew apart. If you installed it as `session-band@claude-kit`, uninstall that and install `turn-gauge@claude-kit`; settings carry over by hand. MIT licensed; see [LICENSE](LICENSE).
