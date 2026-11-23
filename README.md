# claude-kit

My mods for [Claude Code](https://claude.com/claude-code), plus savvy-flow and savvy-progress, forked from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit). Every item is a standalone plugin under `plugins/`: install only what you need.

| Plugin | Type | What it does |
| --- | --- | --- |
| [savvy-flow](plugins/savvy-flow) | skill + agents | `/savvy-flow <task>`: the session model plans, delegates to tiered worker subagents and reviews their work. |
| [savvy-progress](plugins/savvy-progress) | mod | A progress bar above the prompt and a live agents panel. Made for savvy-flow, shows any subagents. |
| [turn-gauge](plugins/turn-gauge) | mod | A band above the prompt: turn, speed, cost, prompt cache countdown, plan limits, context, cache hit rate and tokens, with the model and effort on a second row. Warns on spend (cache misses, output-heavy turns, a long context costing more than starting over, running out before a reset), offers a compact-keeping-recent-turns button, and notifies before the cache expires. |
| [prompt-index](plugins/prompt-index) | mod | A pane listing the session's prompts: click one to jump there, filter, step through matches, see which are on screen. `/prompts` or the footer button toggles it. |
| [stream-radio](plugins/stream-radio) | mod | `/stream <url>`: plays a YouTube stream's audio through mpv. A footer button shows the song and its progress and opens a menu (pause, stop, play last or default, type a URL); it retries with yt-dlp's android client when YouTube refuses. |
| [pr-watch](plugins/pr-watch) | mod | Watches the current branch's PR (or any PR). When CI fails or a merge conflict appears, it wakes this same session to fix it and push, with no cloud session. A footer button sums up the PRs and opens a side panel to watch, check and stop them; `/pr-watch` does the same. |
| [footer-where](plugins/footer-where) | mod | Shows the current directory and git branch at the right of the prompt footer. |

savvy-flow and savvy-progress work on their own and light up together: with both installed, the flow drives the bar and workers report their progress to the panel. The other mods are independent of each other.

## Install

### From the marketplace

In Claude Code:

```
/plugin marketplace add boneyland/claude-kit
/plugin install savvy-flow@claude-kit
/plugin install savvy-progress@claude-kit
/plugin install turn-gauge@claude-kit
/plugin install prompt-index@claude-kit
/plugin install stream-radio@claude-kit
/plugin install pr-watch@claude-kit
```

Restart the session afterwards. Plugin skills and agents are namespaced: the skill is `/savvy-flow:savvy-flow`, the agents `savvy-flow:savvy-careful` and so on.

### With the `claude` CLI

The same, from a shell:

```bash
claude plugin marketplace add boneyland/claude-kit
claude plugin install savvy-flow@claude-kit
claude plugin install savvy-progress@claude-kit
claude plugin install turn-gauge@claude-kit
claude plugin install prompt-index@claude-kit
claude plugin install stream-radio@claude-kit
claude plugin install pr-watch@claude-kit
```

Start a new session afterwards to load them.

### Manually

```bash
git clone https://github.com/boneyland/claude-kit.git ~/claude-kit
```

**A skill** (no plugin system involved, names stay short: `/savvy-flow`, `savvy-careful`): copy its folders into your Claude Code config.

```bash
cp -R ~/claude-kit/plugins/savvy-flow/skills/savvy-flow ~/.claude/skills/
```

```bash
cp ~/claude-kit/plugins/savvy-flow/agents/*.md ~/.claude/agents/
```

**A mod**: load the folder for one session,

```bash
claude --plugin-dir ~/claude-kit/plugins/savvy-progress
```

or for every session (including the desktop app) through `env` in `~/.claude/settings.json`. Several folders are separated with `:`; if the variable is already set, append to it rather than replacing it:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/claude-kit/plugins/savvy-progress"
  }
}
```

`git pull` in the clone updates a mod loaded this way; copied skills need copying again.

Mods are built on function hooks (`hooks/register.tsx`), an early-access Claude Code API: tested on Claude Code 2.1.330, and it may change between releases. If a mod installed from the marketplace does not show up, load it manually as above.

## Update

**Installed from the marketplace, in a session**: type `/plugin`, open the **Installed** tab, pick the plugin and choose **Update now** (**Mark for update** leaves it for later). The tab shows each plugin's installed version.

**Installed from the marketplace, from a shell**: refresh the catalog, then update each plugin:

```bash
claude plugin marketplace update claude-kit
claude plugin update savvy-flow@claude-kit
claude plugin update savvy-progress@claude-kit
claude plugin update turn-gauge@claude-kit
claude plugin update prompt-index@claude-kit
claude plugin update stream-radio@claude-kit
claude plugin update pr-watch@claude-kit
```

Restart the session to apply it. `claude plugin list` shows the installed versions, and the catalog (`.claude-plugin/marketplace.json`) the latest ones.

**Loaded manually**: `git pull` in the clone, then `/reload-plugins` or a new session for a mod. A skill copied into `~/.claude/skills` and `~/.claude/agents` needs copying again after the pull (the `cp` commands above).

## Layout

```
.claude-plugin/marketplace.json   the catalog `/plugin marketplace add` reads
plugins/<name>/
  .claude-plugin/plugin.json      manifest
  skills/<skill>/SKILL.md         a skill
  agents/*.md                     subagents it ships
  hooks/hooks.json                a mod: points at the hooks module
  hooks/register.tsx              a mod: the module itself
  types/index.d.ts                a mod: its $.state contract
```

Check a plugin before publishing: `claude plugin validate plugins/<name>`, and the catalog with `claude plugin validate .`.

## License

MIT
