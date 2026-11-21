# pr-watch: footer button and side panel

## Intent

pr-watch 0.1.0 is driven only by `/pr-watch` and shows state in a band above the prompt. The user didn't know the band was there and wants one place to see and drive everything: a footer button that opens a side panel, like prompt-index's Prompts button and savvy-progress's `/agents-info`.

## Goals

- Remove the band above the prompt (the `AbovePrompt` hook).
- A footer button (`SessionMode` hook), **always shown**, beside the engine's labels and other mods' buttons:
  - panel closed: a short summary
    - nothing watched: `PRs`
    - all green: `PRs 2✓`
    - otherwise counts of what needs a look, e.g. `PRs ✗1 ⏳1` (✗ failing CI or conflict, ⏳ checks running, ? gh error)
  - panel open: `Hide PRs`
  - pressing it opens or closes the panel
- A side panel (`$.ui.open` + a `Pane` render hook) with all of pr-watch's features:
  - **Watch this branch's PR** button
  - **Check now** button
  - an input for a PR number or URL; Enter watches it
  - one row per watched PR: number, state label (the existing `label()`), repo and title, a **Stop** button, a link to open the PR in the browser
  - under a PR with failing CI: each failing check with a link to its run
  - a footer line: poll interval and whether pushing fixes is on
  - feedback from an action (watch failed, not a PR, already watched) shown in the panel, since there's no command reply there
- `/pr-watch` keeps every subcommand; add `/pr-watch panel` to toggle the panel, as `/prompts` and `/agents-info` do.

## Non-goals

- No settings in the panel: `allowPush`, interval and the rest stay in `/config`.
- No change to how PRs are polled, decided or fixed.

## Constraints

- The footer row is shared (stream-radio's label can take ~60 columns): keep the closed label to about 10 characters.
- The panel sizes itself to `e.props.bodyColumns`; long titles are cut.
- The footer button's label follows the pane however it opens or closes (button, command, the pane's own close mark), via `ui.open` / `ui.close` hooks on the pane id, as savvy-progress does.
- An action that may wake the session (watching a PR that already fails) submits its prompt from a timer, as the command path already does: a press handler, like a command hook, shouldn't wait on a turn.

## Approaches

- **Side panel, shared logic with the command** (chosen): the button and `/pr-watch panel` toggle a pane; its buttons and input call the same functions `/pr-watch` does. Stays up and live, which is the point.
- **Pop-up dialog** (stream-radio's menu): closes after one choice and can't show live state. Rejected.
- **Pane plus band**: the user asked for the band to go; the footer summary covers the glance. Rejected.

## Left to the builder

- Exact panel layout and wording, following prompt-index's pane.
- Refactoring the command handler so the command and the panel share watch / stop / check functions.
- Tests: footer label states and toggle (like savvy-progress's `footer-button.test.tsx`), panel rows and actions, and the band's removal. Version 0.2.0; README and catalog updated.
