# footer-where

A Claude Code mod that shows the session's directory and git branch at the right of the prompt footer, after the mode labels and any buttons other mods put there:

```
⏵⏵ auto mode on (shift+tab to cycle)          ~/projects/claude-kit · main
```

The home folder is shortened to `~`, and a long path is cut from the left so the branch stays in view. Outside a repository, or on a detached HEAD, only the directory shows.

Terminal only: the desktop app already shows the directory and branch, so there the mod draws nothing and stays idle.

It reads them again when the session starts, after each tool call in the main conversation (so a `git checkout` or a worktree move shows at once) and at the end of each turn (which catches `/cd`). It redraws only when one of them changed.

## Install

```
/plugin marketplace add boneyland/claude-kit
/plugin install footer-where@claude-kit
```
