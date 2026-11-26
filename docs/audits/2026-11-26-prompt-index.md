# Audit: prompt-index

- Date: 2026-11-26
- Commit: 79a8c19
- Components: prompt-index (561)
- Checklists: correctness, security, efficiency, cleanups, docs-drift, repo-rules
- Audited by: the main agent
- Findings: 4 (0 security, 4 bug, 0 drift, 0 cleanup); 3 dropped at verify

## Bug

### 1. A slash command is listed without its arguments
- Where: `plugins/prompt-index/hooks/register.tsx:40`
- Area: correctness #9
- What: `COMMAND` reads the arguments with a lazy `[\s\S]*?` followed by an optional `<command-args>` group. A lazy match followed by an optional group settles on matching nothing, so the arguments are only captured when `<command-args>` comes straight after `</command-name>`. Real rows put `<command-message>` between them. The test (`register.test.tsx:52`) uses the adjacent form only, so it passes.
- Fails when: you run `/superpowers:brainstorming Write an audit skill`. The pane lists `/superpowers:brainstorming` only, and filtering for "audit" doesn't find it. Checked with node against the stored form: the args capture is `null`.
- Verdict: confirmed
- Seen before: new

### 2. In a long session the earliest prompts drop off the list, and the numbers shift
- Where: `plugins/prompt-index/hooks/register.tsx:217`
- Area: correctness #1
- What: `readPrompts` reads `$.session.messages({ last: 4096 })`. Every tool result is a user message, so a session with about 2000 tool calls passes 4096 messages. Prompts older than the window disappear from the pane, and every prompt is numbered again from 1. The README says the pane lists "the prompts of the current session".
- Fails when: a long agentic session goes past 4096 messages. Prompt 1 vanishes, "showing 4-7 of 40" counts from the first prompt still in the window, and you can't jump back to the start.
- Verdict: confirmed (the 4096 cap is documented on `session.messages` in the generated types)
- Seen before: new

### 3. Long prompts are cut by UTF-16 length, not screen width
- Where: `plugins/prompt-index/hooks/register.tsx:276`
- Area: correctness #6
- What: `cut` compares `text.length` to the pane's width in columns and slices by code unit. CJK characters and emoji take two columns each, and an emoji is two code units, so the slice can split one in half.
- Fails when: a prompt in Chinese or Japanese takes up to twice the pane's width and wraps or overflows its row. A prompt with an emoji at the cut point ends in a lone surrogate (`cut("ab😀cd", 4)` gives `"ab\ud83d…"`), which draws as �.
- Verdict: confirmed
- Seen before: new

### 4. Every drawn row is remembered for the whole session, and each row's redraw scans all of them
- Where: `plugins/prompt-index/hooks/register.tsx:26`
- Area: efficiency #3
- What: `seen` gets an entry for every transcript row ever drawn and never drops one. On each row's render, the generic `ui.render` hook (line 358) calls `inView` over all of `seen` and `sectionsOn` over all prompts, and it also reads the prompts atom. `notTyped` grows the same way.
- Fails when: a session has thousands of rows. Each redraw of N visible rows does N full scans of every row drawn so far, so scrolling costs more and more as the session runs.
- Verdict: plausible (the growth is certain; how much it slows scrolling depends on how often the engine re-renders rows)
- Seen before: new

## Not covered
- nothing (`hooks/register.test.tsx` was read for intent only, as the brief says; `.claude-plugin/icon.png` is an image)
