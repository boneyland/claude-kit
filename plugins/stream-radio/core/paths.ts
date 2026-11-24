// Where the player keeps its files: one fixed folder, so every program that
// drives the same player (the mod, a terminal player) finds the same socket.
export async function stateDir(env: (name: string) => Promise<string | undefined>): Promise<string> {
  const state = await env('XDG_STATE_HOME')
  if (state) return `${state}/stream-radio`
  const home = await env('HOME')
  return home ? `${home}/.local/state/stream-radio` : ''
}
