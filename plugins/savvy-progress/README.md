# savvy-progress

A Claude Code mod: a progress bar above the prompt and a live panel of subagents. Made for the [savvy-flow](../savvy-flow) skill, and useful with any subagents.

- **Progress bar**: the flow's title, phase, accepted tasks out of planned, and a button with the crew size that opens the panel. It appears once something reports progress (savvy-flow does) or a `savvy-*` worker starts.
- **Agents panel** (`/agents-info` toggles it; `/agents-info open` opens it or brings it forward without toggling): running, finished and planned subagents with model, effort, task progress, context, estimated cost and time. Working crabs walk, and each savvy tier animates its prop: the astronaut floats, the detective sweeps the magnifier, the engineer turns the wrench, the chef tosses the omelette, the racer runs with a fluttering flag. `prefers-reduced-motion` stops them. That's the desktop app; in the terminal each agent gets Clawd as Claude Code's own logo draws it (`▐▛███▜▌` in quarter-block characters), who scuttles side to side while it runs, half a cell at a time at 8 frames a second, swapping legs as it goes. Each crab is a `Raster` the panel repaints in place with `$.ui.blit`, so the animation redraws only the crab's cells, not the panel, and stops while the panel is closed. Panels narrower than 40 columns show the plain `▣` mark instead; panels 98 columns or wider list the agents two to a row. Each agent the engine still tracks has an **Open** button that shows its transcript in the main view, as picking it from the tasks list does; a finished agent loses the button once the engine drops its task.
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

`autoOpen`: `savvy` (default) or `any`. With `savvy` the panel opens by itself when a `savvy-*` worker starts or a plan is reported. With `any` it also opens, once per session, when any other subagent starts. `/agents-info` toggles it either way.

Install instructions are in the [repository README](../../README.md).
