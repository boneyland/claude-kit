# Docs drift

Words that tell the user or the next reader something the code doesn't do.
Both past audits here found these, and they mislead more than they seem to:
the next change is made from the comment, not the code. A finding quotes the
words, names where they are, and says what the code actually does.

1. **Comments.** A comment describing a different order, condition or result
   than the code below it. Example (f25f771): NowPlaying's comment said the ★
   came after the title; it comes before.
2. **Help text and hints.** Key lists, `?` screens, footer hints, menu labels
   and `--help` output that name a key, a behaviour or a limit the code
   doesn't have. Example (a4f039f): the hint for `o` said it played; it goes to
   a location.
3. **READMEs.** Each component's README and the root README: features,
   keys, settings, defaults and install steps checked against the code.
4. **Manifests and descriptions.** `plugin.json` and `marketplace.json`
   descriptions, skill and command `description:` lines, agent definitions:
   do they still describe what ships?
5. **Messages to the user.** Notices, toasts and errors whose wording no
   longer matches the case that shows them (a message for "not ready" shown
   when the queue is empty).
6. **Tests named for behaviour they don't check.** A test's name promising
   something its assertions no longer test.
