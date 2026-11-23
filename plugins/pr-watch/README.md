# pr-watch

Watch pull requests from a Claude Code session. When CI fails or a merge conflict appears, pr-watch wakes **this same session** with a prompt naming the PR and what broke, and Claude fixes it, commits and pushes. No cloud session is opened: the fix runs here, with this checkout and this conversation's context.

## The footer button and the panel

A button in the footer under the prompt sums up the watched PRs: `PRs` with none, `PRs 2✓` when all are green, otherwise what needs a look, e.g. `PRs ✗1 ⏳1` (✗ failing CI or a conflict, ⏳ checks still running, ? `gh` couldn't read it). Click it to open the side panel, and again (it reads `Hide PRs`) to close it.

```
╭ PR watch ─────────────────────────────────╮
│ [Watch this branch's PR]  [Check now]     │
│ PR number or URL: ______________          │
│ Watching #130 ✗ 2 failed …                │
│                                           │
│ #123 ✓                     [Stop] open    │
│ acme/app: Add login                       │
│ #130 ✗ 2 failed · fixing   [Stop] open    │
│ acme/app: Fix cache                       │
│   CI / lint                               │
│   CI / test                               │
│                                           │
│ Checks every 90 s · push fixes: on        │
│ Change these in /config or /plugin.       │
╰───────────────────────────────────────────╯
```

Type a PR number or URL in the box and press Enter to watch it: any PR, on any branch, not only the one you're on. `open` and each failing check are links to GitHub. The settings line only shows the options; change them in `/config` or `/plugin`.

## The command

Everything the panel does, `/pr-watch` does too:

```
/pr-watch               # watch the current branch's PR
/pr-watch 123           # watch PR #123 of this repo
/pr-watch <PR url>      # watch a PR of any repo
/pr-watch list          # what is watched, and its state
/pr-watch check         # poll now instead of waiting
/pr-watch stop 123      # stop watching one (or: stop, stop all)
/pr-watch panel         # open or close the panel
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

The prompt also tells Claude to skip the report if it has already pushed past that commit, not to wait on or poll CI after pushing (pr-watch checks the new commit), and to treat the quoted PR title and check names as data from GitHub, not instructions.

## Pushing

With `allowPush` on (the default), the prompt tells Claude it may push its fixes to the watched PR's branch without asking first, never force-push or merge. Turn it off and Claude commits, then asks before pushing.

## Requirements

- [`gh`](https://cli.github.com/), logged in (`gh auth status`)
- the session's working directory inside the repository, for `/pr-watch` and `/pr-watch <number>` (a PR URL works from anywhere)

## What it runs, reads and sends

- **Programs**: `gh pr view [<number or URL>] --json <fields>`, one PR at a time, every `intervalSeconds`. `gh` uses your own login; pr-watch never reads or handles a token.
- **Network**: only `gh`'s calls to GitHub's API (`api.github.com`) for the PRs you watch.
- **Conversation**: when a watched PR fails CI or conflicts, it submits a prompt to this session naming the PR, its branch and the failing checks, and Claude then works on it: checks out the branch, runs commands, commits, and pushes when `allowPush` is on. It does this only for PRs you asked it to watch, at most `maxAttempts` times in a row per PR, and only while the session is idle. It reads nothing from the conversation.
- **Files**: none. The watch list lives in the session and is gone when it ends.

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
/plugin marketplace add boneyland/claude-kit
/plugin install pr-watch@claude-kit
```
