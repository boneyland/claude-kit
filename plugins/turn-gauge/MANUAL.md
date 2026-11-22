# turn-gauge manual

What every part of the band shows, when it appears, and how its numbers are worked out. For installation see the [README](README.md).

- [The band](#the-band)
- [Narrow windows](#narrow-windows)
- [The cache countdown and frame](#the-cache-countdown-and-frame)
- [Cache notifications](#cache-notifications)
- [Spend warnings](#spend-warnings)
- [The compact button](#the-compact-button)
- [How costs are measured](#how-costs-are-measured)
- [Commands and settings](#commands-and-settings)
- [Band background colors](#band-background-colors)
- [Restarts and resumed sessions](#restarts-and-resumed-sessions)

## The band

One row above the prompt, left to right. In the terminal the icons are emoji (⏱️ ⚡ 💰 ⏳ 🌿) or, with the *Terminal icons* setting, glyphs (`⏱ ⚡ $ ⧗ ⎇`) colored like the band. The desktop app draws its own ring icons.

| Item | Shows | Notes |
|---|---|---|
| **Turn** | `Turn 12` | Counts your prompts that ran a turn. A subagent's run is part of the turn that started it, not a turn of its own. |
| **Timer** | `⏱ 3m` | While a turn runs, whole minutes since it started (`<1m` in the first minute, `1h05m` past an hour). Between turns it holds how long the last turn took, until the next one starts. |
| **Speed** | `80 tok/s` | Output speed of the last response, timed from its first streamed item, so time-to-first-token is left out. Responses under 20 tokens, under 0.5 s, or over 1000 tok/s are ignored as noise; the last good reading stays. |
| **Cost** | `$0.12 (agents $0.08) · med $0.30 · avg $0.45 \| $3.40` | The last turn's cost, the **median** and **mean** cost of the last 10 turns, and the session total. A turn's cost is the change in the session cost Claude Code reports since you sent the prompt, so it includes any subagents it ran; `(agents …)` is their part, shown when the window is 80 columns or wider, as `<$0.01` under half a cent (a light Haiku 5.5 subagent often costs that little). It comes from each agent's own cost as Claude Code reports it, counting what the agent spent from the turn's start until the next turn starts: a background agent that is still working after the turn ends adds to that turn, in the band and in the median and mean. The median is a typical turn; the mean, pulled up by long runs, shows what they add. The median and mean appear after the first turn finishes. |
| **Cache** | `43m · 96%` | Minutes left on the 1-hour prompt cache since the last answer, rounded up; see [below](#the-cache-countdown-and-frame). Then the last turn's **cache hit rate**: the share of its input read from the cache, which is billed at about a tenth of normal input. Amber under 80%, red when the turn had a [cache miss](#cache-miss). Long sessions sit above 90%; a turn that reads big files lowers it without anything being wrong. |
| **Tokens** | `Σ 840k in · 21k out` | The session's input and output tokens, subagents included. Input counts every request's whole context (cached or not), so it grows fast: it is how much was *read*, not what it cost. Output is priced several times input (5× on most models), so it is the one to watch. |
| **Limits** | `5h 24% →61% ↻2h10m` `wk 41% →78% ↻3d` | Your plan's 5-hour and weekly usage, on a subscription only. Amber from 70%, red from 90%. `→` is where the window [ends at this pace](#pace-projection) (80 columns and wider): dim normally, amber from 90%, red `→100%+` when it runs out before the reset. `↻` is the time until the window resets. Saved across sessions, so a new session shows them before its first answer; a window whose reset has passed shows 0% until the next reading. |
| **Branch** | `⎇ main*` | The git branch, or the short commit when detached. `*` and amber mean uncommitted changes. Read every 15 seconds and after each turn, but not while the band is hidden; names over 24 characters are cut short. Not shown outside a repository. |
| **Model** | `opus-5-5 · high` | The current model and the effort level the last request carried. Shown at the right of the second row, which is always there while the model is shown; warnings go on its left. |
| **Context** | `████░░░░░░ 40%` | How full the context window is. The bar is green under 45%, yellow from 45%, orange from 65% and red from 85%: 10 cells of `█` and `░` in the terminal, a ring and a bar in the desktop app. |
| **×** | | Hides the band for the rest of the session. `/turn-gauge` brings it back. |

Before a session's first answer the band only appears if your plan's limits are already known.

## Narrow windows

The row never wraps. As the window narrows it drops details instead:

| Width (columns) | What changes |
|---|---|
| 96 and wider | Everything, including the context bar and the limit reset times. |
| 80–95 | No context bar or reset times; tokens as `Σ 840k/21k`. |
| 64–79 | `# 12` instead of `Turn 12`, `80/s` instead of `80 tok/s`, cost as `$0.12 · $0.30/$0.45` (no agents part); no branch, effort level or tokens. |
| 50–63 | No turn number, session total, model or hit rate; smaller icons. |
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

The second row under the band holds the model at its right. While idle, its left shows a warning when something costs more than it should. They are ranked in this order: cache expired, [cache miss](#cache-miss), [output-heavy turn](#output-heavy-turn), [running out before the reset](#running-out-before-the-reset), overhead. The row shows the top one, and the next one beside it, after a dim `│`, when both fit the window's width. Each has its own `×`, at the left of its text (the band's hide `×` is at the right end); the cache miss and output-heavy warnings share one. Hiding the band and showing it again, or reloading plugins, brings every dismissed warning back.

Cache expired and overhead are about carrying a long context, and both compare against the **baseline**: what a new session in this project starts with (system prompt, tools, CLAUDE.md and so on). The **old context** is everything above the baseline, the part a new session wouldn't carry. Neither warning shows while the old context is under 60k tokens.

### Cache expired

> `Cache expired: next turn rewrites 180k ≈ $1.44 · new session ≈ $0.16`

Shown once the cache has lapsed, when starting over would save at least $0.10. It compares writing the whole context back against writing only a new session's baseline. A `/compact` at this point costs more than either, because it also reads the uncached context.

### Running out before the reset

> `Heads up: weekly limit runs out Mon 14:21, 20h before reset`

Shown when the [pace projection](#pace-projection) of the 5-hour or weekly window reaches 100% before it resets. When both do, the one that runs out first is shown. `×` hides it for the rest of that window. Unlike the other warnings, it also shows after the cache has expired, beside or instead of the expired-cache warning.

### Cache miss

> `Cache miss: last turn re-wrote 84k ≈ $0.66 extra (hit 10%) · a tool, MCP, CLAUDE.md or plugin change resets the cache`

Each request in the main session should read the previous request's whole context from the cache. Whatever part it didn't read, and wrote again instead, is a **miss**. The row shows when the last turn missed 20k tokens or more, with what the re-write cost over reading it. That is the 1-hour write price minus the read price, so it is an estimate.

It stays quiet when the band knows the cause:

- the cache had expired (that's the warning above)
- the conversation was compacted
- the model changed
- the session is new, restarted or resumed

Anything else means the start of the prompt changed: tools or MCP servers connecting or dropping, a CLAUDE.md edit, plugins reloaded, or a setting that changes the system prompt. Subagents start their own caches, so they never count. `×` hides it until the next turn.

### Output-heavy turn

> `Output-heavy turn: 34k tokens out ≈ $0.68 · 62% of the turn's cost`

Shown when the last main turn wrote 30k output tokens or more **and** that output came to at least 40% of the turn's cost, at list prices. Long answers, big file writes and heavy thinking add up here. A long agentic turn usually writes plenty of output but pays mostly for re-reading its context on every request; that cost belongs to the Overhead row, so the output row stays quiet then. `×` hides it until the next turn.

### Overhead

> `Carry cost ≈ $0.42/turn (130k × 16 req) · new session ≈ $0.16 once → pays back in 1 turn · /compact ≈ $0.47 once → pays back in 2 turns`

The `/compact` part appears only once a compaction's summary size has been measured; until then the row ends after the new-session payback. See [Payback](#payback) below.

Shown while the cache is still warm. Even with caching, every request in a turn re-reads the whole context, so carrying the old context costs something every turn:

```
carry cost per turn = old context tokens × cache-read price × median requests per turn
```

The median is taken over the last 10 turns, so one long agentic run doesn't set the price for the rest. On Haiku 5.5, a prompt over 100k tokens pays its long-prompt rates (5× the short ones) on all of it, while a new session's baseline is priced at the short rates; the carry cost is then the whole context read at the long rate minus the baseline read at the short one.

The row appears only when **all** of these hold:

1. No turn is running, and the cache hasn't expired.
2. Prices are known: the model is in the price table, or its price scale has been measured (see [How costs are measured](#how-costs-are-measured)).
3. The baseline is known.
4. The **old context** is at least 60k tokens: that's the **context minus what a new session would start with**.
5. At least 3 turns have finished, since one turn says little about the next.
6. The carry cost is **at least 60% of a typical turn's cost** (the median of the last 10 turns, subagents included) **and at least $0.05**.
7. You haven't dismissed it with `×`. A dismissed row comes back once the context grows another 50k tokens, or after a compaction.

So the trigger is a share, not a price line: the row says most of what you pay each turn goes to re-reading context a new session wouldn't carry. Both sides use the same model's prices, so it works the same on every model; the $0.05 floor keeps a large share of pennies quiet. Short question-and-answer turns rarely reach it; long tool-heavy turns over a long context do.

### Payback

The row gives each alternative's one-off cost and how many turns of carry cost it takes to pay for itself:

- **New session:** the cost of caching a fresh baseline, divided by the carry cost per turn.
- **`/compact`:** reading the context once, writing the summary, and re-caching baseline plus summary, divided by what the summary saves each turn. Left out when the summary wouldn't be smaller than the old context.

The `/compact` estimate needs a measured summary size, so it is missing until a compaction has been seen. Only a plain compaction in the main session counts: Claude Code's `/compact` or auto-compaction. The mod's own [`compact, keep N`](#the-compact-button) button and `/turn-gauge compact` don't, because what they leave includes the kept turns. Neither do ahead-of-time compactions or a subagent's. One plain `/compact` in any session is enough; the size is kept across sessions (the median of the last 5).

## Pace projection

Where each plan window (5-hour and weekly) ends if you keep going at the current pace. It works from the plan's own `used %`, the same figure the band shows, not from token counts, so it fits any plan.

**Readings.** Every session saves a reading each time a window's percentage moves. Readings are shared across sessions and projects. Usage from claude.ai or the desktop app shows up the next time a Claude Code session reads the limits. Between two readings, use is taken to be spread evenly.

**Models.** Four forecasts of where the window ends:

| Model | Forecast | Shown |
|---|---|---|
| **Smoothed** | `used + rate × time left`, where the rate is exponentially smoothed: each stretch of the window counts, weighted by `e^(−age/τ)`. τ is 1 hour for the 5-hour window and 1 day for the week, so a break brings it down gradually and an old burst fades. This is simple exponential smoothing of the usage rate. | The 5-hour window, and the week until the profile is ready. |
| **Straight line** | `used ÷ time elapsed × window length`: the window's run rate. This is what tools like codeburn use. | Scored only. |
| **Last window** | `used +` what the previous window used from this same point to its end. This is the *seasonal naive* baseline: a model that can't beat it isn't worth having. For the week it needs the week just before. | Scored only. |
| **Weekly profile** | Learned from finished weeks: points used in each hour of the week, in local time, averaged. The forecast is `used + level × the profile's expected use until the reset`. The **level** is this week's use so far against the profile's (clamped between 0.5× and 2×), so a busier week scales the rest up. It's multiplicative seasonality: Holt–Winters' idea, by hour of week. | The week, once 2 weeks are learned. |

The band's `→` and the heads-up use the *shown* model. Its run-out time is when it reaches 100%: at the smoothed rate, or hour by hour through the profile.

**When it starts.** Nothing is shown for the first 30 minutes of a 5-hour window or the first 12 hours of a week.

### Is it any good?

`/turn-gauge pace` shows each window's forecast from every model, and how each has done. At 25%, 50% and 75% of each window, the mod notes every model's forecast. When the window resets, it compares those forecasts with where usage really ended (the highest reading of the window) and keeps the last 40 windows. Forecasting texts call this rolling-origin evaluation. The score is each model's mean absolute miss in percentage points, at each mark, with the number of windows scored.

A week has to finish before its first score, and the profile needs two finished weeks before it's shown. The 5-hour scores come within a day.

Reference: Hyndman & Athanasopoulos, *Forecasting: Principles and Practice* (3rd ed., free online), for exponential smoothing (ch. 8), seasonal naive baselines and evaluation (ch. 5).

## The compact button

The overhead row carries a **`compact, keep N`** button. It compacts the conversation but keeps the last *N* turns word for word after the summary, so the work you're in the middle of isn't paraphrased. *N* is the *Turns kept when compacting* setting (default 3).

- **It only appears with the overhead row**, so the conditions above apply. To compact at any time, run `/turn-gauge compact [turns]`.
- A turn here is a prompt the model answered. Slash commands you run in the terminal (`/plugin`, `/reload-plugins`, …) don't count.
- If there's nothing before the kept turns to summarize, nothing happens and a toast says why.
- Only this mod's compaction keeps turns. Claude Code's own `/compact`, auto-compaction and ahead-of-time compaction are unchanged.
- After any compaction, the warnings wait for the next request to measure what's left.

## How costs are measured

- **Turn and session cost** come from the cost Claude Code reports for the session; the band doesn't estimate them.
- **Warning prices** start from list prices per model (Claude API, 2026-11-03). Cache reads cost 0.1× input or less, and 1-hour cache writes cost 2× input. Haiku 5.5 has a second, 5× dearer row for prompts over 100k tokens, applied to a request's whole input. After each turn, the mod compares its list-price estimate with the cost Claude Code reported and keeps the ratio as a **scale** (limited to 0.25–4), so the warnings match what you're actually billed. A model not in the table shows no warnings until that scale has been measured. Switching models starts the scale over.
- **The baseline** is measured from the first request of a fresh session in the same project directory, keeping the smallest of the last 5. Until one has been seen, it is taken from `/context`'s breakdown minus the conversation.
- **The compaction summary size** is measured from the first request after a `/compact`, as the median of the last 5. Until a compaction has been seen, the overhead row leaves out the `/compact` estimate.

## Commands and settings

| Command | Does |
|---|---|
| `/turn-gauge` | Show or hide the band. |
| `/turn-gauge compact [turns]` | Compact, keeping the last *turns* turns (default: the setting) word for word. |
| `/turn-gauge pace` | Each plan window's projection and how accurate past projections were. See [Pace projection](#pace-projection). |
| `/turn-gauge demo <minutes>` | Pretend the cache has that many minutes left, to preview the colors, frame and notifications. The next answer resets it. |
| `/turn-gauge width` | Print the band's measured width and tier (for debugging). |

**Settings** (under the plugin's options in `/plugin`):

- *Turns kept when compacting* (`keepTurns`): 1–20, default 3.
- *Terminal icons* (`terminalIcons`): `emoji`, the default, or `glyphs`. Emoji draw in their own colors, so the cache icon doesn't turn amber or red (its countdown still does), and each takes two columns. Glyphs follow the band's colors but need a font that has them.
- *Band background* (`background`): a color behind the band to set it apart from the terminal. Takes hex (`#1e2430` or `#abc`), a color name (`blue`), or a theme key (see [Band background colors](#band-background-colors)). Empty, the default, keeps the terminal's background; anything else is ignored. If the band doesn't change right away, run `/reload-plugins`.

## Band background colors

A hex value or color name is fixed: it stays the same whichever theme you use. A **theme key** names one of the color tokens of your Claude Code theme instead, so the band follows the theme when you switch between light and dark. The tokens are listed, with what each is for, in the *Color token reference* of [Configure your terminal for Claude Code](https://code.claude.com/docs/en/terminal-config).

**Recommended: `userMessageBackground`**, the background of your own messages in the conversation. The band then matches them, and it is meant as a background, so it is usually quiet enough for the band's text.

Most other tokens are colors for text, borders and accents, and behind the band they can be loud or hide its colored text:

| Key | Its color in Claude Code |
|---|---|
| `text`, `inverseText` | default text; text drawn on colored badges |
| `inactive`, `subtle` | secondary text (hints, timestamps); faint borders and dividers |
| `suggestion`, `remember` | autocomplete and picker highlight; memory and `CLAUDE.md` indicators |
| `success`, `error`, `warning`, `merged` | status messages |
| `claude`, `permission` | the primary accent; dialog borders |
| `planMode`, `autoAccept`, `promptBorder`, `bashBorder`, `ide` | mode accents and the input box border |
| `diffAdded`, `diffRemoved` and their `Dimmed` and `Word` variants | diff line backgrounds and word highlights |

The mod's API names the keys above; `userMessageBackground` isn't among them but works, as other tokens from the reference may.

### Tip: a custom theme

To make a theme key a color you like, override it in a custom theme. In `/theme`, choose **New custom theme…** and override the token, or write `~/.claude/themes/<name>.json`:

```json
{
  "name": "My theme",
  "base": "dark",
  "overrides": { "userMessageBackground": "#2a2f3a" }
}
```

Set `base` to the theme you use now so nothing else changes, then pick the theme in `/theme`. Edits to the file apply without a restart. Your own messages change color along with the band. See [Create a custom theme](https://code.claude.com/docs/en/terminal-config) for the token list and color formats.

## Restarts and resumed sessions

After each answer the mod saves the session's turn number, total cost, speed, context fill, cache deadline and recent turn costs (the last 50 sessions are kept). A session that the desktop app restarts or resumes draws its band right away instead of waiting for its next answer, and the session total carries on from where it was. Your plan's limits, the measured baselines and the compaction summary sizes are kept across all sessions.
