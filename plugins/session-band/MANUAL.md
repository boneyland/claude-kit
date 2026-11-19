# session-band manual

What every part of the band shows, when it appears, and how its numbers are worked out. For installation see the [README](README.md).

- [The band](#the-band)
- [Narrow windows](#narrow-windows)
- [The cache countdown and frame](#the-cache-countdown-and-frame)
- [Cache notifications](#cache-notifications)
- [Spend warnings](#spend-warnings)
- [The compact button](#the-compact-button)
- [How costs are measured](#how-costs-are-measured)
- [Commands and settings](#commands-and-settings)
- [Restarts and resumed sessions](#restarts-and-resumed-sessions)

## The band

One row above the prompt, left to right:

| Item | Shows | Notes |
|---|---|---|
| **Turn** | `Turn 12` | Counts your prompts that ran a turn. A subagent's run is part of the turn that started it, not a turn of its own. |
| **Timer** | `⏱ 1:23` | Only while a turn runs: time since it started. |
| **Speed** | `80 tok/s` | Output speed of the last response, timed from its first streamed item, so time-to-first-token is left out. Responses under 20 tokens, under 0.5 s, or over 1000 tok/s are ignored as noise; the last good reading stays. |
| **Cost** | `$0.12 · med $0.30 · avg $0.45 \| $3.40` | The last turn's cost, the **median** and **mean** cost of the last 10 turns, and the session total. A turn's cost includes any subagents it ran. The median is a typical turn; the mean, pulled up by long runs, shows what they add. The median and mean appear after the first turn finishes. |
| **Cache** | `42:17` | Time left on the 1-hour prompt cache since the last answer. See [below](#the-cache-countdown-and-frame). |
| **Limits** | `5h 24% ↻2h10m` `wk 91% ↻3d` | Your plan's 5-hour and weekly usage, on a subscription only. Amber from 70%, red from 90%. `↻` is the time until the window resets. Saved across sessions, so a new session shows them before its first answer; a window whose reset has passed shows 0% until the next reading. |
| **Branch** | `⎇ main*` | The git branch, or the short commit when detached. `*` and amber mean uncommitted changes. Read every 15 seconds and after each turn; names over 24 characters are cut short. Not shown outside a repository. |
| **Model** | `opus-5-5 · high` | The current model and the effort level the last request carried. |
| **Context** | `◔ ▬▬▬ 63%` | How full the context window is. The bar is green, amber from 65% and red from 85%. |
| **×** | | Hides the band for the rest of the session. `/session_data` brings it back. |

Before a session's first answer the band only appears if your plan's limits are already known.

## Narrow windows

The row never wraps. As the window narrows it drops details instead:

| Width (columns) | What changes |
|---|---|
| 96 and wider | Everything, including the context bar and the limit reset times. |
| 80–95 | No context bar or reset times. |
| 64–79 | `# 12` instead of `Turn 12`, `80/s` instead of `80 tok/s`, cost as `$0.12 · $0.30/$0.45`; no branch and no effort level. |
| 50–63 | No turn number, session total or model; smaller icons. |
| Under 50 | No speed and no limits. |

The cost (with its median and mean), cache countdown, context and timer stay at every width.

## The cache countdown and frame

Claude Code caches the conversation for an hour after each answer. While the cache is warm, each request reads the context at the cache-read price. Once it lapses, the next message writes the whole context back at the much higher write price.

- The countdown shows `—` before the first answer, `…` while a turn runs (the cache is being refreshed), and `expired` at zero.
- While idle, the band gets an **amber frame** with 20 minutes left and a **red frame** with 10 minutes left. The frame takes two extra rows; when there isn't room, it is left off and only the countdown changes color.

## Cache notifications

With 10 and then 5 minutes left, while idle, you get a system notification: `Prompt cache expires in 5 min; then the next message costs ≈ $1.84`. The cost is only included when it is $0.10 or more. Nothing fires while a turn runs.

- **On macOS with the notifier built** (`notifier/build.sh`, see the README): the notification has Claude's icon and the title `<project> — <session title>`. In the desktop app, clicking it opens the session.
- **Otherwise:** Claude Code's own notification, which also reaches your phone over Remote Control. If you're already at the session it is skipped and a toast says the same thing.

## Spend warnings

A second row under the band, **only while idle**, when carrying the long context costs more than starting over. There are two kinds; at most one shows at a time.

Both compare against the **baseline**: what a new session in this project starts with (system prompt, tools, CLAUDE.md and so on). The **old context** is everything above the baseline, the part a new session wouldn't carry. Neither warning shows while the old context is under 20k tokens.

### Cache expired

> `Cache expired: next message re-caches 180k ≈ $1.44 · new session ≈ $0.16`

Shown once the cache has lapsed, when starting over would save at least $0.10. It compares writing the whole context back against writing only a new session's baseline. A `/compact` at this point costs more than either, because it also reads the uncached context.

### Overhead

> `Old context ≈ $0.26/turn (130k × 10 req median, 12 mean) · new session pays back in 1 turn · /compact ≈ $0.47, pays back in 2 turns`

Shown while the cache is still warm. Even with caching, every request in a turn re-reads the whole context, so the old context has a steady cost each turn:

```
overhead per turn = old context tokens × cache-read price × median requests per turn
```

The median is taken over the last 10 turns, so one long agentic run doesn't set the price for the rest. The mean is shown beside it.

The row appears only when **all** of these hold:

1. No turn is running, and the cache hasn't expired.
2. Prices are known: the model is in the price table, or its price scale has been measured (see [How costs are measured](#how-costs-are-measured)).
3. The baseline is known.
4. The old context is at least 20k tokens.
5. At least 3 turns have finished, since one turn says little about the next.
6. The overhead is **$0.20 a turn or more**.
7. You haven't dismissed it with `×`. A dismissed row comes back once the context grows another 50k tokens, or after a compaction.

So the trigger is a cost, not a context size. The context size it takes depends on the model's cache-read price and on how many requests your turns make:

| Median requests per turn | Opus 5.5, Fable 5.2 ($0.20/M) | Sonnet 5.5 ($0.10/M) |
|---|---|---|
| 1 | ~1M (effectively never) | ~2M (never) |
| 3 | ~333k | ~667k |
| 5 | ~200k | ~400k |
| 10 | ~100k | ~200k |
| 20 | ~50k | ~100k |

These are old-context sizes, before the price scale is applied. Short question-and-answer turns rarely show it; long tool-heavy turns show it sooner.

**Payback.** The row says how many turns of overhead it takes to pay for the alternative:

- **New session:** the cost of caching a fresh baseline, divided by the overhead per turn.
- **`/compact`** (once a compaction has been measured): reading the context once, writing the summary, and re-caching baseline plus summary, divided by what the summary saves each turn. Left out when the summary wouldn't be smaller than the old context.

## The compact button

The overhead row carries a **`compact, keep N`** button. It compacts the conversation but keeps the last *N* turns word for word after the summary, so the work you're in the middle of isn't paraphrased. *N* is the *Turns kept when compacting* setting (default 3).

- **It only appears with the overhead row**, so the conditions above apply. To compact at any time, run `/session_data compact [turns]`.
- A turn here is a prompt the model answered. Slash commands you run in the terminal (`/plugin`, `/reload-plugins`, …) don't count.
- If there's nothing before the kept turns to summarize, nothing happens and a toast says why.
- Only this mod's compaction keeps turns. Claude Code's own `/compact`, auto-compaction and ahead-of-time compaction are unchanged.
- After any compaction, the warnings wait for the next request to measure what's left.

## How costs are measured

- **Turn and session cost** come from the cost Claude Code reports for the session; the band doesn't estimate them.
- **Warning prices** start from list prices per model (Claude API, 2026-11-03). Cache reads cost 0.1× input or less, and 1-hour cache writes cost 2× input. After each turn, the mod compares its list-price estimate with the cost Claude Code reported and keeps the ratio as a **scale** (limited to 0.25–4), so the warnings match what you're actually billed. A model not in the table shows no warnings until that scale has been measured. Switching models starts the scale over.
- **The baseline** is measured from the first request of a fresh session in the same project directory, keeping the smallest of the last 5. Until one has been seen, it is taken from `/context`'s breakdown minus the conversation.
- **The compaction summary size** is measured from the first request after a `/compact`, as the median of the last 5. Until a compaction has been seen, the overhead row leaves out the `/compact` estimate.

## Commands and settings

| Command | Does |
|---|---|
| `/session_data` | Show or hide the band. |
| `/session_data compact [turns]` | Compact, keeping the last *turns* turns (default: the setting) word for word. |
| `/session_data demo <minutes>` | Pretend the cache has that many minutes left, to preview the colors, frame and notifications. The next answer resets it. |
| `/session_data width` | Print the band's measured width and tier (for debugging). |

**Setting:** *Turns kept when compacting* (`keepTurns`), 1–20, default 3. Change it under the plugin's options in `/plugin`.

## Restarts and resumed sessions

After each answer the mod saves the session's turn number, total cost, speed, context fill, cache deadline and recent turn costs (the last 50 sessions are kept). A session that the desktop app restarts or resumes draws its band right away instead of waiting for its next answer, and the session total carries on from where it was. Your plan's limits, the measured baselines and the compaction summary sizes are kept across all sessions.
