#!/bin/sh
# Installs stream-radio-tui: downloads the built file and puts it in
# ${PREFIX:-$HOME/.local/bin}. Run it again to update.
set -eu

URL="${STREAM_RADIO_TUI_URL:-https://github.com/boneyland/claude-kit/releases/download/stream-radio-tui-rolling/stream-radio-tui.mjs}"
DEST="${PREFIX:-$HOME/.local/bin}"

missing=""
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -lt 22 ]; then
    missing="$missing
  node 22 or newer (found node $major)"
  fi
else
  missing="$missing
  node 22 or newer"
fi
command -v mpv >/dev/null 2>&1 || missing="$missing
  mpv"
command -v curl >/dev/null 2>&1 || missing="$missing
  curl"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  missing="$missing
  sha256sum or shasum"
fi
if [ -n "$missing" ]; then
  echo "stream-radio-tui needs, and did not find:$missing" >&2
  exit 1
fi

command -v yt-dlp >/dev/null 2>&1 || echo "warning: yt-dlp not found; YouTube URLs will not play without it." >&2
command -v python3 >/dev/null 2>&1 || echo "warning: python3 not found; yt-dlp needs it." >&2

mkdir -p "$DEST"
tmp=$(mktemp "$DEST/.stream-radio-tui.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
curl -fsSL "$URL" -o "$tmp"
# The release publishes the file's SHA-256 beside it: a download cut short
# or garbled on the way is never installed.
expected=$(curl -fsSL "$URL.sha256" | cut -d' ' -f1)
actual=$(sha256 "$tmp")
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "stream-radio-tui: the download does not match its checksum; nothing was installed." >&2
  exit 1
fi
chmod +x "$tmp"
mv -f "$tmp" "$DEST/stream-radio-tui"
trap - EXIT HUP INT TERM

echo "Installed $DEST/stream-radio-tui"
case ":${PATH:-}:" in
  *":$DEST:"*) ;;
  *) echo "$DEST is not on your PATH; add it, or run $DEST/stream-radio-tui directly." ;;
esac
