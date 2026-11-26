# Security

Can content or configuration the user didn't write make this code do
something the user didn't ask for? Mods here run inside Claude Code on the
user's machine with their permissions, and read song tags, file names, video
titles, web pages and git repos — all of it untrusted.

1. **Untrusted text reaching the terminal.** Control characters and escape
   sequences in tags, file names, titles, branch names or command output drawn
   without being stripped. Example (a4f039f): OSC 52 in a song's tags could set
   the clipboard.
2. **Command and argument injection.** Untrusted values built into a shell
   string, or passed as an argument that can start with `-` and be read as an
   option (mpv, yt-dlp, git, curl). Prefer argument arrays and `--`.
3. **A repository's or tool's own config running commands.** Example
   (39b5bec): `git status` honoured a repo's `core.fsmonitor` and ran its
   command every poll. Also hooks, aliases, `.npmrc`, editor configs.
4. **Paths from outside.** A path from a playlist, a URL or a setting that
   escapes where it should stay (`..`, absolute paths, symlinks), or is written
   to.
5. **Secrets.** Tokens, emails or file contents written to logs, toasts,
   notifications or sent in requests; credentials read from places the feature
   doesn't need.
6. **Network calls.** Requests the user didn't ask for, to hosts they didn't
   name; untrusted URLs fetched with schemes other than http(s)
   (`file:`, `ftp:`).
7. **Sockets and IPC.** Control sockets created world-writable or in a shared
   directory; replies trusted without checking they answer the request.
8. **Temp files.** Predictable names in shared directories, created without
   exclusive flags, left behind with sensitive content.
