# savvy-progress

A Claude Code mod: a progress bar above the prompt and a live panel of subagents. Made for the [savvy-flow](../savvy-flow) skill, and useful with any subagents.

- **Progress bar**: the flow's title, phase, accepted tasks out of planned, and a button with the crew size that opens the panel. It appears once something reports progress (savvy-flow does) or a `savvy-*` worker starts.
- **Task list bar**: with no flow reported, the bar mirrors Claude Code's own task list (`TaskCreate`/`TaskUpdate`, or `TodoWrite`): the task in progress as its title, completed out of total, and what Claude is doing right now (its latest tool call, such as `Edit parser.ts` or a Bash command's description). A finished list shows Done until the next prompt. Claude sometimes forgets to update the list during long stretches of work, so after 15 tool calls with a task open and no change to the list, one reminder rides along with a tool result asking it to bring the list up to date (or carry on if it still fits), and again after 15 more. A `TaskList` call resyncs the mirror.
- **Agents panel** (`/agents-info` toggles it; `/agents-info open` opens it or brings it forward without toggling; `/agents-info demo` fills it with made-up agents in every state and tier, plus a demo flow with planned tasks when no flow is running, and `/agents-info demo off` removes them): running, finished and planned subagents with model, effort, task progress, context, estimated cost and time. Working crabs walk, and each savvy tier animates its prop: the astronaut floats, the detective sweeps the magnifier, the engineer turns the wrench, the chef tosses the omelette, the racer runs with a fluttering flag. `prefers-reduced-motion` stops them. That's the desktop app. In terminals that show images (kitty, Ghostty) each agent gets the same pixel crab in its tier's costume, with the same motions, drawn as PNG frames into an `Image` and swapped with `$.ui.blit` 8 times a second while it runs; a frame is under a kilobyte and each is made once. Elsewhere, or with `terminalCrabs` set to `cells`, each agent gets Clawd as Claude Code's own logo draws it (`▐▛███▜▌` in quarter-block characters), who scuttles side to side while it runs, half a cell at a time at 8 frames a second, swapping legs as it goes. Each crab is a `Raster` the panel repaints in place with `$.ui.blit`, so the animation redraws only the crab's cells, not the panel, and stops while the panel is closed. Panels narrower than 40 columns show the plain `▣` mark instead; panels 98 columns or wider list the agents two to a row. Each agent the engine still tracks has an **Open** button that shows its transcript in the main view, as picking it from the tasks list does; a finished agent loses the button once the engine drops its task.
- **Footer button**: **Agents** at the right of the prompt footer opens the panel and **Hide agents** closes it, as `/agents-info` does. It is pressed with the mouse.

## Tools it adds

- `mcp__savvy-progress__progress`: the orchestrator reports the plan, phase and accepted tasks. Only the main session can: a call from a subagent is ignored, so a worker cannot rename, finish or reset the flow.
- `mcp__savvy-progress__step`: a worker reports its own steps (`done`, `total`, `note`). The report shows as `3/5 note` on the agent's row, in its tier's color; a worker that does not report shows only its context fill, cost and time. The tool is listed up front rather than behind ToolSearch, and each `savvy-*` worker gets one line at the end of its brief asking for these reports.

Cost is a rough estimate from token counts and a built-in per-model price table (`PRICES` in `hooks/register.tsx`, list prices as of 2026-10-10), not a bill. Cache writes are priced at the 1-hour rate, which is what Claude Code writes on a subscription; a session that writes 5-minute entries is overestimated there.

## Settings

`language`: `auto` (default), `en`, `ru` or `he`. Hebrew draws the bar and the panel right to left. `auto` follows Claude Code's `language` setting, then the system locale, and falls back to English. Set it in `/config`, or, for a mod loaded by hand, in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "savvy-progress": { "options": { "language": "ru" } } } }
```

`terminalCrabs`: `auto` (default), `pixels` or `cells`. `auto` draws pixel sprites in kitty and Ghostty (or wherever `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`), and switches to the quadrant-block Clawd for the session if the terminal turns a sprite away.

`taskList`: `nudge` (default), `mirror` or `off`. `nudge` mirrors the task list in the bar and sends the reminder above; `mirror` draws the bar without reminders; `off` leaves the task list alone.

`autoOpen`: `savvy` (default) or `any`. With `savvy` the panel opens by itself when a `savvy-*` worker starts or a plan is reported. With `any` it also opens, once per session, when any other subagent starts. `/agents-info` toggles it either way.

Install instructions are in the [repository README](../../README.md).
