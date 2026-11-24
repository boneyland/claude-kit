import fs from 'node:fs/promises'
import type { PlayerConfig } from '../../../plugins/stream-radio/core/player'
import { clampVolume } from '../../../plugins/stream-radio/core/nowplaying'

export type TuiConfig = PlayerConfig & { defaultUrl: string }

export const DEFAULT_CONFIG: TuiConfig = { volume: 60, player: 'mpv', androidClient: false, defaultUrl: '' }

// ${XDG_CONFIG_HOME or HOME/.config}/stream-radio/config.json. A missing or
// unreadable file, or a field of the wrong type, gives that field's default.
export async function loadConfig(env: Record<string, string | undefined>): Promise<TuiConfig> {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? `${env.HOME}/.config` : '')
  if (!base) return { ...DEFAULT_CONFIG }
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(`${base}/stream-radio/config.json`, 'utf8'))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_CONFIG
  return {
    volume: typeof o.volume === 'number' && Number.isFinite(o.volume) ? clampVolume(o.volume) : d.volume,
    player: typeof o.player === 'string' && o.player ? o.player : d.player,
    androidClient: typeof o.androidClient === 'boolean' ? o.androidClient : d.androidClient,
    defaultUrl: typeof o.defaultUrl === 'string' ? o.defaultUrl : d.defaultUrl,
  }
}
