# prompt-index

A Claude Code mod: a pane listing the prompts of the current session, as a stand-in for the conversation's missing scrollbar.

- **Jump**: click a prompt (or focus it and press Enter) to scroll the transcript to it.
- **Where you are**: the prompts whose sections are on screen, counting their replies and tool calls, are marked `▌` and drawn bright. The line under the buttons gives their numbers (`showing 4-7 of 40`).
- **Filter and step**: type in the field to keep only matching prompts. Enter or `↓ next` jumps to the next match, `↑ prev` to the previous one, wrapping round at the ends.

Slash commands Claude answered are listed as typed (`/superpowers:brainstorming`): skills and commands that send a prompt. Commands Claude Code runs by itself with no reply (`/plugin`, `/reload-plugins`, `/exit`) are left out, as are tool results, command output and notifications. A command whose turn is still running is listed straight away.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-index --marketplace boneyland/prompt-index
```

Answer `y` to add the marketplace, then pick a scope (user is first; press Enter).

From a shell:

```bash
claude plugin install prompt-index --marketplace boneyland/prompt-index
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `boneyland/prompt-index`, then Add plugin.

## Use

Click **Prompts** at the right end of the prompt footer, or run `/prompts`, to open the pane; **Hide prompts** or `/prompts` again closes it. The pane docks beside the transcript under fullscreen rendering (`/tui fullscreen`).

## Develop

Run it from a clone:

```bash
claude --plugin-dir path/to/prompt-index
```

```bash
claude plugin validate .
claude plugin test .
```
