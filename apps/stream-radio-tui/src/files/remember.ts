import type { Host } from '../../../../plugins/stream-radio/core/host'

// The TUI's own file beside the player's: the last folder browsed in Files.
const fileOf = async (h: Host) => {
  const dir = await h.dataDir()
  return dir ? `${dir}/tui-files.json` : ''
}

// Never throws: a folder that can't be remembered is only forgotten.
export async function rememberFolder(h: Host, folder: string): Promise<void> {
  try {
    const file = await fileOf(h)
    if (file) await h.fs.write(file, JSON.stringify({ folder }))
  } catch {
    // nothing to do
  }
}

// '' when none was remembered.
export async function lastFolder(h: Host): Promise<string> {
  try {
    const file = await fileOf(h)
    if (!file) return ''
    const folder = JSON.parse(await h.fs.read(file))?.folder
    return typeof folder === 'string' ? folder : ''
  } catch {
    return ''
  }
}
