# pr-watch Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pr-watch's band above the prompt with an always-shown footer button that toggles a side panel exposing every pr-watch feature.

**Architecture:** A pure `summary()` in `watch.ts` makes the footer label. `register.tsx` gains shared action functions (watch / unwatch / check) that both `/pr-watch` and the panel call, a `SessionMode` footer button, and a `Pane` render hook; the `AbovePrompt` hook is deleted. Pane open state is kept in an atom, kept in step by `ui.open` / `ui.close` hooks, as prompt-index does.

**Tech Stack:** Claude Code function hooks (TypeScript/TSX, `claude-code` API 2.1.330), `gh` CLI, `claude plugin test` / `claude plugin validate`.

**Spec:** `docs/superpowers/specs/2026-11-21-pr-watch-panel-design.md`

## Global Constraints

- Plugin folder: `plugins/pr-watch/`. Run tests with `~/.local/bin/claude plugin test plugins/pr-watch` and validation with `~/.local/bin/claude plugin validate plugins/pr-watch`, both with the Bash sandbox off.
- Pane id `pr-watch`, title `PR watch`. Footer button key `pr-watch-toggle`.
- Footer label, panel closed: nothing watched `PRs`; all green `PRs 2✓`; otherwise counts that need a look, e.g. `PRs ✗1 ⏳1` (✗ failing CI or conflict, ⏳ checks running, ? gh error). Panel open: `Hide PRs`. Keep it to about 10 characters.
- The button is always shown, even with nothing watched.
- No settings in the panel; `allowPush`, interval etc. stay in `/config`.
- Polling, `decide()` and `buildPrompt()` do not change.
- A prompt that may wake the session is submitted from a timer (`$.clock.after(0, ...)`), never awaited inside a command or press handler.
- Version 0.2.0 in `plugin.json` and `.claude-plugin/marketplace.json`.

## Review Focus

- A PR watched both from the panel and `/pr-watch` (same PR twice): one row, "Already watching" notice, no second prompt. → test in Task 2.
- The pane closed by its own close mark: footer label goes back to the summary. → test in Task 3.
- Watching fails (no PR for the branch, gh error) from the panel: the reason shows in the panel, nothing thrown. → test in Task 3.
- Input text that isn't a PR number or URL submitted in the panel: notice with the usage, nothing watched. → test in Task 3.
- A reload with the pane up: the label matches the pane (read `$.ui.panes()` in `session.start`, as prompt-index does). → covered by implementation in Task 3, checked in review.

---

### Task 1: Footer summary label

**Files:**
- Modify: `plugins/pr-watch/hooks/watch.ts`
- Test: `plugins/pr-watch/hooks/watch.test.ts`

**Interfaces:**
- Produces: `export function summary(list: Watched[]): string` in `watch.ts`.

- [ ] **Step 1: Write the failing test** `test('the footer summary', ...)` in `watch.test.ts`, using the existing `status()` and `newWatched()` helpers:

```ts
expect(summary([])).toBe('PRs')
const green = newWatched(status())
expect(summary([green, { ...green, url: 'u2', number: 13 }])).toBe('PRs 2✓')
const failing = { ...green, status: status({ failing: [{ name: 'x', url: '' }] }) }
const conflict = { ...green, number: 14, status: status({ isConflicting: true }) }
const running = { ...green, number: 15, status: status({ pending: 2, total: 3 }) }
const broken = { ...green, number: 16, error: 'HTTP 401' }
expect(summary([green, failing, conflict, running])).toBe('PRs ✗2 ⏳1')
expect(summary([broken, green])).toBe('PRs ?1')
// failing with checks still running counts as ✗, not ⏳
expect(summary([{ ...green, status: status({ failing: [{ name: 'x', url: '' }], pending: 1 }) }])).toBe('PRs ✗1')
```

- [ ] **Step 2: Run** the tests; expect FAIL (`summary` not exported).
- [ ] **Step 3: Implement `summary`.** Per PR, the first that applies: error → `?`; failing or conflicting → `✗`; pending → `⏳`; else green. All green → `PRs N✓`; else join the non-zero counts in the order `✗ ⏳ ?` as `✗n`, after `PRs `. A PR with `status: null` and no error counts as `⏳`.
- [ ] **Step 4: Run** the tests; expect all PASS.
- [ ] **Step 5: Commit** `pr-watch: footer summary label`.

### Task 2: Shared actions, `/pr-watch panel`, band removed

**Files:**
- Modify: `plugins/pr-watch/hooks/watch.ts` (`parseArgs`, `USAGE`)
- Modify: `plugins/pr-watch/hooks/register.tsx`
- Test: `plugins/pr-watch/hooks/watch.test.ts`, `plugins/pr-watch/hooks/register.test.tsx`

**Interfaces:**
- Consumes: existing `fetchStatus`, `apply`, `poll`, `listText`, `describe` in `register.tsx`.
- Produces, in `register.tsx` (module-level, not exported):
  - `async function watchTarget($: EngineInterface, config: Config, target: string): Promise<string>`: the reply text (the command's current watch reply, or the failure line); schedules `apply` with `$.clock.after(0, ...)`.
  - `async function unwatchTarget($: EngineInterface, target: string): Promise<string>`: `target` is `'all'`, a number or a URL; returns the current stop reply text.
  - `async function checkNow($: EngineInterface, config: Config): Promise<string>`: runs `poll`, returns `listText`.
- `Command` gains `{ kind: 'panel' }`; `USAGE` becomes `'Usage: /pr-watch [<number> | <PR url>] | stop [<number> | <PR url> | all] | list | check | panel'`.

- [ ] **Step 1: Write failing tests.** In `watch.test.ts` `arguments`: `expect(parseArgs('panel')).toEqual({ kind: 'panel' })`, `expect(parseArgs('panel x').kind).toBe('error')`. In `register.test.tsx`, a test `watching the same PR twice keeps one row and asks once`: watch `''` twice with the failing-PR reply, `clock.settle()` after each, assert one `prompts` entry, the second reply contains `Already watching`, and `list` shows `#12` once. And a test `no band above the prompt`: mount `AbovePrompt` with a PR watched and assert `ui.find({ type: 'Text', text: /#12/ })` is undefined.
- [ ] **Step 2: Run** the tests; expect the three new assertions to FAIL.
- [ ] **Step 3: Implement.** Add `panel` to `parseArgs`. Move the bodies of the command's watch, unwatch and check branches into the three functions above; the command calls them. Delete the `AbovePrompt` `ui.render` hook. The `panel` branch is wired in Task 3; until then it returns `{ text: 'The panel arrives in the next step.' }`.
- [ ] **Step 4: Run** the tests; expect all PASS.
- [ ] **Step 5: Commit** `pr-watch: share watch/stop/check actions; drop the band`.

### Task 3: Footer button and side panel

**Files:**
- Modify: `plugins/pr-watch/hooks/register.tsx`, `plugins/pr-watch/types/index.d.ts`
- Create test: `plugins/pr-watch/hooks/panel.test.tsx`

**Interfaces:**
- Consumes: `summary` (Task 1); `watchTarget`, `unwatchTarget`, `checkNow`, `parseArgs` (Task 2); existing `label`, `Watched`.
- Produces: state keys `isOpen: boolean` and `notice: string` in the `pr-watch` contract; atoms `isOpen` (false) and `notice` ('') in `register.tsx`; `async function toggle($: EngineInterface): Promise<'opened' | 'closed'>`, shaped like prompt-index's `toggle` (`$.ui.panes()`, `$.ui.open({ id: 'pr-watch', title: 'PR watch' })`, `$.ui.close`).

- [ ] **Step 1: Write failing tests** in `panel.test.tsx`, looped over `['terminal', 'desktop'] as const`, mocking `ui.panes` / `ui.open` / `ui.close` as savvy-progress's `footer-button.test.tsx` does, and `process.run` / `prompt.submit` as `register.test.tsx` does:
  - `footer button`: label is `PRs` with nothing watched; press `pr-watch-toggle` → pane `pr-watch` opened, label `Hide PRs`; press again → closed, label `PRs`. After watching a failing PR (via `/pr-watch`) and closing, label `PRs ✗1`. `$.command.run({ command: 'pr-watch', args: 'panel' })` opens it and the label follows. Closing through `$.ui.close({ id: 'pr-watch' })` sets the label back.
  - `panel actions`: mount `Pane` with `requestId: 'pr-watch'` and `props: { title: 'PR watch', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }`. Press `watch-branch` → a row Text matching `/#12/`; the failing check's name `CI / test` shows; a `Link` with `href` the PR URL exists. Press `stop-12` → the row is gone. `input` on key `target` with `submit` text `'nope'` → a Text containing `Usage:`. With `process.run` answering exit 1 and `no pull requests found`, press `watch-branch` → a Text containing `no pull requests found`. Press `check` → `process.run` called with the PR URL.
- [ ] **Step 2: Run** the tests; expect FAIL.
- [ ] **Step 3: Implement.**
  - Contract: add `isOpen: boolean` and `notice: string`.
  - `toggle`, `ui.open` / `ui.close` hooks on `{ id: 'pr-watch' }` that set `isOpen`, and `session.start` syncing `isOpen` from `$.ui.panes()`: copy prompt-index's pattern.
  - `/pr-watch panel` → `toggle`, replying `PR watch panel opened.` / `closed.`.
  - `SessionMode` hook: `<Box flexDirection="row" gap={1}>{await next(e)}<Button key="pr-watch-toggle" label={open ? 'Hide PRs' : summary(list)} onPress={() => toggle($)} /></Box>`.
  - `Pane` hook (`requestId: 'pr-watch'`), top to bottom: a row of Buttons `watch-branch` ("Watch this branch's PR") and `check` ("Check now"); an `Input` key `target`, placeholder `PR number or URL`, `onSubmit` → `parseArgs(value)`: a `watch` with a target calls `watchTarget`, anything else sets `notice` to `USAGE`; the `notice` Text (dim) when non-empty; `No PRs watched.` when the list is empty; per PR a row with `label(w).text` in its tone, `repo: title` cut to `bodyColumns`, a `Button` key `stop-<number>` ("Stop") and a `Link` `href={w.url}` label `open`; under it, when `status.failing` is non-empty, one line per check with a `Link` to `check.url` (text only when the URL is empty); last, a dim line `Checks every N s · push fixes: on|off`.
  - Every panel action writes its reply text into `notice`.
- [ ] **Step 4: Run** all tests; expect PASS. Run validate; expect `✔ Validation passed` with no `❯ line` type warnings.
- [ ] **Step 5: Commit** `pr-watch: footer button and side panel`.

### Task 4: Docs and version

**Files:**
- Modify: `plugins/pr-watch/.claude-plugin/plugin.json` (version `0.2.0`; description: footer button and panel instead of band), `.claude-plugin/marketplace.json` (pr-watch version `0.2.0`, description to match), `plugins/pr-watch/README.md` (replace the band section with the footer button and panel, with a text sketch of the panel; add `/pr-watch panel`), `README.md` (pr-watch row: footer button and panel).

- [ ] **Step 1:** Make the edits above.
- [ ] **Step 2:** Run `claude plugin validate .` and `claude plugin validate plugins/pr-watch`; expect both `✔ Validation passed`. Run the tests once more; expect all PASS.
- [ ] **Step 3: Commit** `pr-watch 0.2.0: footer button and side panel replace the band`.
