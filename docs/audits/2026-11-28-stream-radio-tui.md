# Audit: stream-radio-tui

- Date: 2026-11-28
- Commit: a07e2a2
- Components: stream-radio-tui (6940)
- Checklists: correctness, security, efficiency, consistency, cleanups, docs-drift, repo-rules
- Audited by: 1 subagent
- Findings: 7 (1 security, 4 bug, 0 drift, 2 cleanup); 0 dropped at verify

## Security

### 1. Rename prompt sends a playlist's file name to the terminal uncleaned
- Where: `apps/stream-radio-tui/src/ui/PlaylistsView.tsx:100`
- Area: security #1
- What: `NamePrompt` returns a fragment of raw strings (`label`, `before`, `after`). App.tsx:923 wraps it in `<Text>`, but `Text`'s `cleaned()` (src/ui/Text.tsx:13) only cleans strings and arrays. A fragment element passes through untouched, so its strings reach Ink with their control characters. NowPlaying.tsx:132 notes the same limit. For Rename the label is `` Rename "${from}" to: `` (libraryKeys.ts:521), and `from` is a name taken from a `.m3u` file name. Core's `namesIn` (plugins/stream-radio/core/libraryFile.ts:36) does no control-character check; `checkName` checks only names that are typed in.
- Fails when: a file such as `\x1b]52;c;<base64>\x07.m3u` is in the playlists folder (synced, unpacked, or written by another program) and the user chooses Rename on it. The row shows the cleaned name, but the prompt writes the raw OSC 52 sequence, which sets the clipboard. Any other escape sequence in a name goes through the same way.
- Verdict: confirmed
- Seen before: new

## Bug

### 2. Files tab never re-reads a folder it has already listed
- Where: `apps/stream-radio-tui/src/files/useFiles.ts:81`
- Area: correctness #4
- What: `load()` returns early for any listing already in `listingsRef`. Only `putListing` and the YouTube path write to the map, and nothing removes or refreshes an entry. Every later visit to a folder reuses the listing from the first visit, for the rest of the session.
- Fails when: you browse `~/Music/New`, then copy in or delete an album while the TUI runs. Going back (`../` and back, `o ~/Music/New`, `G`) shows the old contents: new songs are missing, and deleted ones still list and fail when added. Only a restart fixes it.
- Verdict: confirmed
- Seen before: new

### 3. Ctrl-C during install doesn't stop the installer; it deletes the temp file and retries
- Where: `apps/stream-radio-tui/install.sh:57`
- Area: correctness #5
- What: `trap 'rm -f "$tmp"' EXIT HUP INT TERM` removes the temp file on INT/TERM/HUP but never exits, so `sh` carries on and counts the interrupted command as failed.
- Fails when: you press Ctrl-C while `curl` downloads. The script prints "could not download …; a new build may be being published. Trying again in 10 s (2 of 3)" and starts again. A Ctrl-C during `sleep` only skips the wait. It takes one Ctrl-C per try to stop it. The signal traps should end with `exit` (e.g. 130 for INT).
- Verdict: confirmed
- Seen before: new

### 4. Row menu measures its width in UTF-16 units, so a CJK playlist name wraps the Delete confirm
- Where: `apps/stream-radio-tui/src/ui/Menu.tsx:12`
- Area: correctness #6
- What: the width is `label.length + key.length + 4`, and labels are padded with `padEnd`, both counting code units rather than columns. Checklist.tsx measures with `textWidth`. `` confirmMenu(`Delete "${name}"`) `` (libraryKeys.ts:357) puts a user-chosen name into a label.
- Fails when: you press Delete on a playlist named `日本語の歌`. The box is 20 columns wide inside, but the label row takes 25 cells, so Ink wraps it onto a second line. The frame grows, and "Keep it" and its click target move down a row.
- Verdict: confirmed
- Seen before: new

### 5. Files sorted by artist and reversed put untagged files first; Queue and Playlists keep them last
- Where: `apps/stream-radio-tui/src/files/tree.ts:45`
- Area: consistency #3
- What: `fileOrder` ranks untagged files last (line 22), but `fileRows` multiplies the whole comparison by `sign`, so reversing flips that rule too. `sortOrder` (src/queue/sort.ts:34), used by the Queue and Playlists, keeps rows with an empty key last "whichever way round".
- Fails when: in Files, `S` to `artist`, then `R`. Every file with no artist tag, including those whose tags haven't been read yet, goes to the top, then jumps away when its tags arrive. The same steps in the Queue or a playlist leave untagged songs at the end.
- Verdict: confirmed
- Seen before: new

## Cleanup

### 6. Files tree is rebuilt whenever new tags arrive, even when nothing on it uses tags
- Where: `apps/stream-radio-tui/src/files/useFiles.ts:135`
- Area: efficiency #3
- What: the `tree` memo always depends on `tagsSeen`. The tag book's version goes up as often as every 100 ms (src/media/tags.ts:58) while any tab is reading tags, and `useFiles` stays mounted on every tab. Each bump re-sorts every open listing in `fileRows`, then runs `filterFileRows` and App's `fKey` join (App.tsx:147) again. The Files tree only needs tags when sorting by `artist`/`albumArtist` or when a filter is typed.
- Fails when: a 5000-song queue's tags are being read while Files has a large folder open. The whole Files tree is rebuilt and re-sorted up to 10 times a second, whichever tab is showing.
- Verdict: confirmed
- Seen before: new

### 7. App's "Pick songs inside a playlist." branch can't be reached, and the string is kept twice
- Where: `apps/stream-radio-tui/src/ui/App.tsx:311`
- Area: cleanups #2
- What: `keyTarget` returns `'top'` only on the Playlists tab when no list is open. In that state `pl.handle` (libraryKeys.ts:483) handles a bare `favourite`/`addToList` first and shows `PICK_INSIDE` itself. Menu actions carry `songs` or `isPlaying`, so `targetOf` returns before `keyTarget` is called. Help, menu and checklist modes never produce these actions (keys.ts:175). Remove the branch, App's `PICK_INSIDE` (App.tsx:50) and the `'top'` case, which leaves the string only in libraryKeys.ts:27.
- Fails when: never at runtime. The duplicate string can fall out of step unnoticed when one copy is edited.
- Verdict: confirmed
- Seen before: new

## Not covered
- apps/stream-radio-tui/package-lock.json — generated, not read
- apps/stream-radio-tui/test/** — read only in part, to learn what the code should do. Docs-drift #6 (test names against their assertions) was not checked across the suite, in particular test/app.test.tsx (2765 lines), queue-edit, queue-store and test/manual
