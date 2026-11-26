# Cleanups

Code that works but costs more to read and change than it should. Report one
only when you can name the concrete simpler form — "this could be cleaner" is
not a finding. These rank last; keep them few and worth doing.

1. **Duplication.** The same logic written twice where one helper, often one
   that already exists in this component or in `plugins/stream-radio/core/`,
   would do. Name the existing helper. (Copies that already differ, and lists
   kept in step by hand, belong under consistency.)
2. **Dead code.** Exports nothing imports, branches that can't be reached,
   options nothing sets, files nothing loads. Check with `grep` across the
   whole repo before reporting: `core/` is shared.
3. **Wrong altitude.** A low-level detail (a socket command, a path format)
   handled in UI code, or UI wording decided deep in a library, so a change
   has to touch both.
4. **Needless complexity.** Indirection, state or generality with one user;
   a hand-rolled version of something the platform or a dependency already
   does.
5. **Misleading names.** A name that says something different from what the
   thing does (overlaps docs drift; report under whichever is the clearer
   fix).
6. **Overgrown functions.** A function or component doing several jobs that
   could be told apart, long enough that a reader can't hold it at once
   (a few hundred lines, deep nesting, a `switch` that has become a program).
   Name the pieces it would split into and what each one would take and
   return. Length alone isn't a finding: a long, flat list of cases that each
   do one thing is fine.
7. **Inconsistent patterns.** Within the component, two ways of doing the
   same small thing (async style, naming, how state is held, error shapes)
   where one is clearly the component's usual way. Name the usual way and the
   places that differ. When the difference changes behaviour, report it under
   consistency #3 instead.
