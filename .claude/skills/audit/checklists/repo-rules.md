# Repo rules

This repo's own rules, which a generic review doesn't know. The rules live in
`CLAUDE.md` at the repo root — read it first, and check the component against
every rule there that applies, not only the ones listed below. Don't copy the
rules into this file; if CLAUDE.md changes, this checklist should follow it
without an edit.

1. **Versions.** For a plugin: its version in
   `plugins/<name>/.claude-plugin/plugin.json` equals its entry in
   `.claude-plugin/marketplace.json`. Also look at `git log` for the plugin:
   were there changes since the last version bump? (Claude Code only updates
   a plugin from GitHub when the version changes.)
2. **Shared code.** `plugins/stream-radio/core/` is used by more than one
   consumer (the stream-radio mod and `apps/stream-radio-tui/`). Anything in
   `core/` that assumes one consumer — its UI wording, its config, its
   lifetime — is a finding. Grep both consumers for each export you question.
3. **Tests as documented.** The component's tests are run the way CLAUDE.md
   and CI (`.github/workflows/`) say. Read them; don't run them. A test that
   depends on the environment in a way CLAUDE.md doesn't mention (path length,
   network, a real mpv) is a finding.
4. **Machine constraints.** Code or scripts in the component that could
   allocate without bound, start unbounded processes, or run `make -j`/worker
   pools uncapped (see CLAUDE.md and the global constraints it points to).
5. **Catalog.** The plugin's entry exists in `marketplace.json`, its `source`
   points at the right folder, and its manifest passes the shape
   `claude plugin validate` expects (read it; don't run it).
