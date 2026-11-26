# Correctness

Does the code do what its names, comments and callers expect, for every input
it can actually get? A finding here is a bug: a concrete input or sequence of
events that gives a wrong result, a crash, or a hang.

1. **Boundaries.** Empty lists, the first and last item, index -1, zero and
   negative numbers, a value exactly at a limit. Example: a queue index of -1
   meaning "none" read as a real place.
2. **Missing or malformed input.** A file that isn't there, JSON that doesn't
   parse or has the wrong shape, a setting left unset, a tag with no value. Is
   each read guarded, and does the fallback make sense?
3. **Async order and races.** A second press or event while the first one's
   work is still running; a reply that arrives after the state it answers has
   changed; a stale closure reading an old value. Example: S pressed again
   while a sort runs — only the last one asked should run after it.
4. **State that outlives its owner.** State not reset when what it describes
   changes or ends. Example (39b5bec): a subagent's `turn.start` counted as a
   turn and reset the turn's cost.
5. **Error paths.** Errors swallowed so the user sees nothing, or reported as
   the wrong thing (a timeout shown as "not ready"), or a `catch` that leaves
   half-done state behind.
6. **Text width and graphemes.** Emoji, CJK and combining characters measured
   or cut as if one code unit were one cell. Example (a4f039f): Backspace in
   the filter took off half an emoji.
7. **Process and IPC.** Child processes, sockets and pipes: what happens when
   the other side is gone, slow, or answers twice? Are exit codes and stderr
   read?
8. **Cleanup.** Timers, watchers, listeners and child processes stopped when
   their owner unmounts or the session ends.
9. **Contracts between parts.** A caller passing what the callee's comment
   says it can't take; two parts disagreeing on a format, a path or a unit
   (seconds vs ms).
