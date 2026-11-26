# Audit brief

You are auditing one component of the claude-kit repo (`/home/yh/projects/claude-kit`):

**Component:** `{{COMPONENT}}`
**Checklists:** `{{CHECKLISTS}}` (six files: correctness, security, efficiency,
cleanups, docs-drift, repo-rules)
{{EXCLUDE}}

This is an audit of the whole component as it stands, not of a diff.

## Rules

- **Read-only.** Do not edit, create or delete any file.
- **No tests, no builds, nothing heavy.** Do not run tests, builds, `npm`,
  `npx`, `bun`, `claude plugin test`/`validate`, browsers, mpv, yt-dlp, or
  anything that installs or downloads. Other audits run in parallel with you
  on a laptop that freezes under memory pressure; reading is all this needs.
  You may use Read, Grep, Glob, `ls`, `wc`, `git ls-files`, `git log` and
  `git show`, and a one-line `node -e` to try a regex or a small pure helper
  on a sample input — nothing that imports the project or starts a process.
- **Concrete or nothing.** Report a finding only when you can name the input or
  state that goes wrong and what the wrong result is. An idea you can't make
  concrete, or aren't fairly sure of, is left out — not listed as "possible".
  A short report of real findings beats a long one of guesses.

## How to work

1. List the component's files with `git ls-files -- {{PATHSPEC}}`. Audit
   only those; code outside them is read only to follow a finding's path.
2. Read `CLAUDE.md` at the repo root (for repo-rules), then every listed file
   in full. Read tests only to learn what the code is meant to do; tests are
   not themselves under audit except for docs-drift #6.
3. Work through each checklist in order — correctness, security, efficiency,
   cleanups, docs-drift, repo-rules — check by check. For each check, look for
   it across the whole component before moving on.
   For what the Claude Code engine's API does (`$.session.messages`, `$.ui.*`,
   hook events and their limits), grep the generated types in
   `plugins/*/.claude-plugin/types/claude-code/index.d.ts` — git-ignored, so
   `git ls-files` won't list them, and ~15k lines, so grep for the call and
   read around it rather than reading the file. Don't guess an API's limits.
4. Before reporting a finding, open the lines again and follow the path you
   claim fails. When the finding depends on code outside the component (a
   `core/` helper, a caller), read that code too.
5. If part of the component is too large to read in full or can't be read,
   say so under "Not covered" instead of skimming it.

## What to return

Return only the findings and the "Not covered" list, in exactly this shape —
nothing before or after. Number nothing; the conductor numbers the report.

```
### <short title>
- area: <correctness|security|efficiency|cleanups|docs-drift|repo-rules> #<check number>
- where: <repo-relative path>:<line>
- severity: <security|bug|drift|cleanup>
- what: <the defect, one or two sentences>
- fails when: <input or state → wrong result>
- confidence: <high|medium>

### <next finding>
...

## Not covered
- <file or area> — <why>
```

Severity: `security` for anything in the security checklist with a real path
to harm; `bug` for wrong results, crashes, hangs, leaks and repo-rule
breaches; `drift` for words that disagree with the code; `cleanup` for the
rest. If you found nothing in an area, say nothing about it. If you found
nothing at all, return only `## Not covered` (with `- nothing` if so).
