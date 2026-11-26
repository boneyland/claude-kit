---
name: audit
description: Audit a whole component of claude-kit (one plugin, the stream-radio TUI app, stream-radio's shared core, or the whole repo) against written checklists — correctness, security, efficiency, cleanups, docs drift and this repo's own rules. Verifies every finding, writes a numbered report to docs/audits/, prints a short summary and waits for the user to say what to fix. For whole components as they stand, not diffs; for a diff or PR use /code-review.
---

# Audit

Audits one component of this repo, or all of them, the same way every time.
The method is in this folder: `worker-prompt.md` is the brief whoever audits a
component follows, and `checklists/` holds what they check. Improve those, not
the wording of a request.

This skill **reports and stops**. It never edits the code under audit. Fixing
is a separate request, after the user has read the report.

## 1. Scope

Components:

| Name | Directory |
|---|---|
| each plugin, by its folder name | `plugins/<name>/` (for `stream-radio`, excluding `core/`) |
| `stream-radio-core` | `plugins/stream-radio/core/` |
| each app, by its folder name | `apps/<name>/` |
| `all` | every component above |

List them fresh each run (`ls plugins apps`) — never from memory, so a new
plugin or app is covered without editing this file.

Take the scope from the arguments. If there is none, or **any** name in it
matches no component, **ask before reading any code**: list every component
with its line count (step 2's command), say which name wasn't found, and ask
with AskUserQuestion which to audit, or `all`. Several named components are
fine; audit those.

## 2. Size

Count each component's lines:

```bash
git ls-files -- <dir> | grep -v '\.test\.' | grep -Ev '\.(png|jpg|webp|lock)$|package-lock' | xargs cat | wc -l
```

For `stream-radio`, add `':!plugins/stream-radio/core'` to the `git ls-files`
pathspec.

Fill `worker-prompt.md`'s placeholders the same way on both paths below:

- `{{COMPONENT}}` — the directory
- `{{PATHSPEC}}` — the directory; for `stream-radio`,
  `plugins/stream-radio ':!plugins/stream-radio/core'`
- `{{CHECKLISTS}}` — `/home/yh/projects/claude-kit/.claude/skills/audit/checklists`
- `{{EXCLUDE}}` — for `stream-radio`, the line
  `**Excluded:** plugins/stream-radio/core/ (audited as its own component)`;
  otherwise remove the placeholder.

Then:

- **One component under 3000 lines:** audit it yourself, following the
  filled brief as your own, word for word.
- **Anything larger** (a bigger component, several, or `all`): one
  general-purpose subagent per component, all dispatched in one message so
  they run in parallel, each given the full filled brief.

  Don't set a model or effort; the subagents take the session's. They are
  read-only and run nothing heavy, as the brief says. Don't relax that: several
  heavy commands at once freeze this machine.

## 3. Verify

Whoever audited, check every finding yourself before it goes in the report:

1. Open the lines at `where` and follow the `fails when` path through the
   code, including code it calls outside the component.
2. **Confirmed** — the path holds: keep it.
   **Plausible** — the path holds but depends on something you can't see
   from the code (timing, what a host or mpv really does): keep it, marked
   plausible.
   **Dropped** — the code doesn't do what the finding says, or there's no
   concrete `fails when`: leave it out. Don't soften it into "possible".
3. Merge findings that are the same defect seen from two places; keep the
   clearest `where`.
4. Correct a severity that doesn't match the brief's definitions.

## 4. Compare

Find the newest earlier report for exactly this scope — the same `<scope>`
as step 5's file name, so a `stream-radio` audit never compares against
`stream-radio-core` or `stream-radio-tui`, and `all` compares only against
`repo`:

```bash
ls docs/audits | awk -v s='<scope>' '
  BEGIN { re = s; gsub(/\+/, "[+]", re) }
  match($0, "^[0-9]{4}-[0-9]{2}-[0-9]{2}-" re "(-[0-9]+)?\\.md$") {
    r = substr($0, 12 + length(s)); n = (r ~ /^-/) ? substr(r, 2) + 0 : 1
    print substr($0, 1, 10), n, $0
  }' | sort -k1,1 -k2,2n | tail -1 | cut -d' ' -f3
```

It prints the file with the newest date, then the highest `-N` suffix (the
first report of a day counts as 1), or nothing. If there is one, mark each finding
**repeat** (the same defect is in it, still unfixed) or **new**. With no
earlier report, every finding is new.

## 5. Report

Write `docs/audits/YYYY-MM-DD-<scope>.md` — `<scope>` is the component name,
`repo` for `all`, or the names joined with `+`. If that file exists already,
add `-2`, `-3`, ….

```markdown
# Audit: <scope>

- Date: YYYY-MM-DD
- Commit: <git rev-parse --short HEAD>
- Components: <name (lines)>, …
- Checklists: correctness, security, efficiency, cleanups, docs-drift, repo-rules
- Audited by: <the main agent | N subagents>
- Findings: <n> (<x> security, <y> bug, <z> drift, <w> cleanup); <d> dropped at verify

## Security

### 1. <title>
- Where: `<path>:<line>`
- Area: <area> #<n>
- What: …
- Fails when: …
- Verdict: confirmed | plausible
- Seen before: new | repeat (<earlier report's file name>)

## Bug
### 2. …

## Drift
…

## Cleanup
…

## Not covered
- <file or area> — <why>   (or "- nothing")
```

Number findings 1..n through the whole report, in the order security, bug,
drift, cleanup, so the user can say "fix 1, 3 and 7". Leave out a severity
heading with no findings. Always include `## Not covered`, carrying over
every worker's "Not covered" list, and add any component whose worker failed
or returned nothing usable.

Commit the report to main (no push):

```bash
git add docs/audits/<file> && git commit -m "audit: <scope>" -- docs/audits/<file>
```

## 6. Summary, then stop

In the terminal, short:

- the counts by severity, and how many were dropped at verify
- the top five findings, one line each, with their numbers
- the report's full absolute path, as a link

Then ask which numbers to fix, and stop. Don't start fixing.

## Improving this skill

When an audit missed something that was found later, add the pattern to the
matching file in `checklists/`, with the commit that fixed it as the example.
When a run went wrong (too slow, too shallow, the wrong shape), fix this file
or `worker-prompt.md`. Commit the change with the skill's other files.
