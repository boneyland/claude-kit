# Consistency

Things that must agree with each other, kept in step only by hand: copies of
the same logic, lists that mirror each other, and the same job done in
several places. For each one, first ask: **do they already differ?**

- **They differ:** severity `bug`. The concrete failure is the case that
  goes through one copy and gets a different result than through the other.
  Quote both places.
- **They still agree:** severity `cleanup`. Name the single source that
  would replace them, such as a shared helper, a derived list, a `Record`
  keyed by a union type, or a test that compares them, and only when that
  source is concrete.

Search across the whole repo, not only this component. `plugins/stream-radio/core/`
is shared with `apps/stream-radio-tui/`, and plugins copy from each other.

1. **Copies that have drifted apart.** The same logic, message or constant
   written in two or more places, where one copy changed and the other
   didn't. Grep for distinctive strings, names and regexes. Example: the TUI
   (cb491f9) and the stream-radio mod each had their own wording for
   stopped-with-an-empty-queue; only one was changed at first, and the mod's
   needed its own fix (#23).
2. **Lists kept in step by hand.** Two or more lists that must hold the same
   items or the same order, with nothing that enforces it: key bindings and
   the help screen, an array of options and its labels, a union type and a
   `switch` over it with a `default`, a manifest and a catalog, README tables
   and the code. A list tied together by a type (`Record<Union, …>`, an
   exhaustive `switch` with no `default`) or by a test that compares them
   (`apps/stream-radio-tui/test/help-docs.test.ts`) is already enforced, so
   it's not a finding. Check that the test really covers every list it seems
   to.
3. **The same job done differently.** Within the component, and across
   components when they share a purpose: running a child process, reading a
   settings file, handling a failed read, sanitizing text before drawing it,
   timing out a request. Report it when the odd one out lacks a protection
   the others have (a bug), or when the difference has no reason anyone could
   name (a cleanup). A difference with a reason, like a host API that isn't
   available there, isn't a finding.
