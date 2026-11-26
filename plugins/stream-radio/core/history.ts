// The play history's recorder: a Lua script mpv runs (launch() hands it over
// with --script), so a song is recorded whichever program, if any, is open.
// It appends one JSON line per play to history.jsonl: { at, path, title,
// artist?, duration? }, `at` the unix seconds the play started.
import type { Host } from './host'
import { paths } from './paths'
import { writeWhole } from './storedFile'

// A play counts once `min` seconds have played (paused time and seeks don't
// count), or at its end for a song shorter than about that, played nearly whole. A loop under Repeat one
// is a new play: mpv starts no new file for it, only seeks back to the start,
// so a seek from the last 2 s to the first 2 s is taken as the song again.
// Past `cap` lines the file is rewritten to the last `keep` (temp and rename).
export const HISTORY_LUA = `-- stream-radio: records each play in history.jsonl. Written by stream-radio;
-- edits are replaced the next time it starts the player.
local utils = require 'mp.utils'
local options = require 'mp.options'

local o = { file = '', min = 30, cap = 2000, keep = 1000 }
options.read_options(o, 'stream_radio_history')

-- the play under way: its start, path, seconds played and whether it is logged
local play = nil
-- time-pos at the last tick, or where a seek landed, so a jump is not counted
local last = nil
-- where the last tick (or seek) saw the song: near its end before a seek back
-- to the start, that seek is a loop
local seen = nil
local count = 0

local function count_lines()
  local f = io.open(o.file, 'r')
  if not f then return 0 end
  local n = 0
  for _ in f:lines() do n = n + 1 end
  f:close()
  return n
end

-- Rewrites the file to its last o.keep lines.
local function trim()
  local f = io.open(o.file, 'r')
  if not f then return end
  local all = {}
  for l in f:lines() do all[#all + 1] = l end
  f:close()
  local tmp = o.file .. '.lua.tmp'
  local out = io.open(tmp, 'w')
  if not out then return end
  for i = math.max(1, #all - o.keep + 1), #all do out:write(all[i], '\\n') end
  out:close()
  if os.rename(tmp, o.file) then count = math.min(#all, o.keep) else os.remove(tmp) end
end

local function record()
  if o.file == '' or not play or play.logged then return end
  play.logged = true
  local line = utils.format_json({
    at = play.at,
    path = play.path,
    title = play.title,
    artist = play.artist,
    duration = play.duration,
  })
  if not line then return end
  local f = io.open(o.file, 'a')
  if not f then return end
  f:write(line, '\\n')
  f:close()
  count = count + 1
  if count > o.cap then trim() end
end

-- A song that ends before it could reach o.min counts at its end, if it played
-- nearly all the way (the ticks count up to about 1 s short, so a song up to
-- o.min + 2 s long counts here too). A long song skipped to near its end
-- doesn't: it would have reached o.min had it played.
local function ended()
  if not play or not play.duration or play.duration >= o.min + 2 or play.played <= 0 then return end
  if play.played >= math.min(play.duration, o.min) - 2 then record() end
end

-- What the line says of the song, read while it plays: at its end-file the
-- properties are gone, and a stream's title is the one at that moment.
local function note()
  play.title = mp.get_property('media-title')
  play.artist = mp.get_property('metadata/by-key/artist')
  play.duration = mp.get_property_number('duration')
end

-- The path played, absolute for a local file named relative to mpv's folder.
local function play_path()
  local p = mp.get_property('path') or ''
  if p ~= '' and not p:find('://', 1, true) and p:sub(1, 1) ~= '/' then
    p = utils.join_path(mp.get_property('working-directory') or '', p)
  end
  return p
end

local function start()
  play = { at = os.time(), path = play_path(), played = 0, logged = false }
  last = mp.get_property_number('time-pos')
  note()
end

mp.register_event('file-loaded', start)

mp.register_event('seek', function()
  local pos = mp.get_property_number('time-pos')
  local d = play and play.duration
  if seen and d and pos and seen >= d - 2 and pos < 2 then
    -- back to the start from its end: the song again (Repeat one)
    ended()
    start()
  end
  -- counted from where it landed, not from before the jump
  last = pos
  seen = pos
end)

mp.register_event('end-file', function(e)
  if e.reason == 'eof' then ended() end
  play = nil
  last = nil
  seen = nil
end)

mp.add_periodic_timer(1, function()
  if not play then return end
  local pos = mp.get_property_number('time-pos')
  if not pos then return end
  if not mp.get_property_bool('pause') and not mp.get_property_bool('idle-active') and last then
    local step = pos - last
    local fast = math.max(1, mp.get_property_number('speed') or 1)
    if step > 0 and step <= 2 * fast then play.played = play.played + step end
  end
  last = pos
  seen = pos
  note()
  if play.played >= o.min then record() end
end)

count = count_lines()
`

// Writes the script to the state folder when what is there differs; its path,
// or '' when it could not be written (the player then starts without it).
export async function installHistoryScript(h: Host): Promise<string> {
  try {
    const { historyLua } = await paths(h)
    const was = await h.fs.read(historyLua).catch(() => '')
    if (was !== HISTORY_LUA) await writeWhole(h, historyLua, HISTORY_LUA)
    return historyLua
  } catch (error) {
    h.log(`stream-radio: could not install the history script: ${error instanceof Error ? error.message : String(error)}`, 'debug')
    return ''
  }
}
