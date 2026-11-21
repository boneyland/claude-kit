# pr-watch

Watch pull requests from a Claude Code session. When CI fails or a merge conflict appears, pr-watch wakes **this same session** with a prompt naming the PR and what broke, and Claude fixes it, commits and pushes. No cloud session is opened: the fix runs here, with this checkout and this conversation's context.

```
/pr-watch               # watch the current branch's PR
/pr-watch 123           # watch PR #123 of this repo
/pr-watch <PR url>      # watch a PR of any repo
/pr-watch list          # what is watched, and its state
/pr-watch check         # poll now instead of waiting
/pr-watch stop 123      # stop watching one (or: stop, stop all)
```

While anything is watched, a band above the prompt shows each PR:

```
PRs  #123 ✓  #130 ✗ 2 failed · fixing  #131 ⏳ 3/7  #140 conflict
```

## How it decides

Every 90 seconds (configurable) pr-watch runs one `gh pr view` per watched PR, one after another. It costs no tokens: Claude only hears about it when something needs fixing.

- **Failing CI**: once every check on the PR's head commit has finished and some failed, so the prompt lists all the failures with their run links.
- **Merge conflict**: as soon as GitHub reports the PR as conflicting. The prompt asks for a merge of the base branch (not a rebase), so no force-push is needed.
- **Once per commit**: each problem is reported once per head commit. A fix pushes a new commit, which is checked again; the same broken commit never triggers a second prompt.
- **A cap**: after 3 fixes in a row (configurable) that still fail, pr-watch stops asking and tells you, until the PR is green again.
- **Merged or closed** PRs are dropped from the list.

The prompt tells Claude which PR and branch, and Claude takes care of the checkout itself: switching to the branch, or using a worktree if this checkout has other work in it. The prompt waits until the session is idle, so it never interrupts a turn.

When you watch a PR that is already failing, it is reported right away.

## Pushing

With `allowPush` on (the default), the prompt tells Claude it may push its fixes to the watched PR's branch, never force-push or merge. Turn it off and Claude commits, then asks before pushing.

## Requirements

- [`gh`](https://cli.github.com/), logged in (`gh auth status`)
- the session's working directory inside the repository, for `/pr-watch` and `/pr-watch <number>` (a PR URL works from anywhere)

## Options

| Option | Default | |
| --- | --- | --- |
| `intervalSeconds` | 90 | how often each PR is checked, 30 to 3600 |
| `allowPush` | on | Claude may push fixes to the watched PR's branch |
| `fixCi` | on | wake the session for failing CI |
| `fixConflicts` | on | wake the session for merge conflicts |
| `maxAttempts` | 3 | fixes in a row per PR before pr-watch stops asking |

The watch list belongs to the session: it survives `/reload-plugins`, and a new session starts with none.

## Install

```
/plugin install pr-watch@claude-kit
```
