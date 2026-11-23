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
│ Check every 30 s 1 min [90 s] 5 min 15 min│
│ Push fixes [on]                           │
╰───────────────────────────────────────────╯
```

Type a PR number or URL in the box and press Enter to watch it: any PR, on any branch, not only the one you're on. `open` and each failing check are links to GitHub. The bottom rows change two options: click an interval to check that often (the current one is in brackets), and click **on**/**off** to switch whether Claude may push its fixes. A change applies at once and is saved as the plugin's option, as `/config` would; if saving is refused (say a managed setting owns it) it still holds for this session, and the panel says why.

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

## pr-watch or `/steward`?

Claude Code has a built-in `/steward` that also watches a pull request from this session, with no cloud session. Both check GitHub without spending tokens and wake Claude only when something changes. They differ in scope and in how tightly Claude is held. This comparison is from Claude Code 2.1.330's `/steward`.

| | pr-watch | `/steward` |
| --- | --- | --- |
| Which PRs | Any number at once, on any branch, from any repo (by number or URL) | One: your open PR for the branch checked out here, opened by your `gh` account |
| What it handles | Failing CI and merge conflicts | Failing CI, conflicts, falling behind the base, and review comments: it answers them, resolves threads it fixed, re-requests reviews, and re-runs a flaky job once |
| Comments it reads | None | Yours, people with write access, Claude's bot, and other bots you name with `+name` |
| Checking | `gh pr view` every 90 s (30 s to 1 h, configurable); Claude is prompted once per broken commit, once the session is idle | Claude Code checks every 2 minutes and wakes Claude a few minutes after a change, at most once every 10 minutes; a quiet watch costs no turn |
| Limits on Claude | The prompt asks for no force-push and no merge; this session's normal permissions apply | A fence enforced by Claude Code: only listed `gh`/`git` commands, never merge or rewrite history, never edit settings or hook files, git hooks skipped. Comments, logs and code are treated as data, never as instructions |
| Giving up | After 3 failed fixes in a row per PR (configurable), until the PR is green again | After 3 pushes for one cause |
| Pushing | `allowPush` on: pushes fixes; off: commits and asks first | Pushes; holds the next push until the last one's checks have reported |
| Ends | When the PR is merged or closed, or you stop it | Merged or closed, base branch changed, a cloud agent's label appears, its settings files change, after a set number of days, or `/steward stop` |
| Unattended | Works in any permission mode that lets Claude run `gh` and `git` | Needs auto mode; elsewhere Claude stops at each permission prompt |
| Status | Footer button and side panel, one row per PR | Status lines in the chat |

Use `/steward` when one PR needs looking after end to end, review comments included, with Claude kept on a short leash. Use pr-watch to keep an eye on several PRs at once, or PRs on branches you don't have checked out, where only red CI and conflicts need fixing. Don't watch the same PR with both: each would push its own fixes.

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
