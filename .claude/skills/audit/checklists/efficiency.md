# Efficiency

Is work done more often, or on more data, than it needs to be? This matters
more here than usual: the user's laptop has ~15GB RAM and zram swap with no
OOM relief, so unbounded memory freezes the whole desktop (see CLAUDE.md,
machine constraints). A finding names the cost (how often, how much) and the
input that makes it large.

1. **Unbounded memory.** Whole files read into memory where streaming would
   do; maps, caches, logs or histories that grow without a cap over a long
   session; big strings sliced and joined repeatedly.
2. **Unbounded fan-out.** Child processes, requests or workers started per
   item with no limit (one ffmpeg/mpv/yt-dlp per file in a 5000-file folder).
3. **Work per redraw or per poll.** Sorting, parsing, stat-ing or spawning
   inside a render or a timer tick when the inputs haven't changed; missing
   memoization keys, or keys that change every time.
4. **Polling where an event exists.** A timer reading state that a watcher,
   socket event or hook already delivers; or polling far faster than the thing
   can change.
5. **Repeated I/O.** The same file read or the same command run several times
   for one action; N+1 patterns over a list.
6. **Leaks.** Listeners, timers or processes added on each mount, render or
   event and never removed (overlaps correctness #8; report it once, under
   whichever area its main cost is).
