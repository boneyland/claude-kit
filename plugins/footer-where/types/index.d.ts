export type Where = {
  /** The session's directory, `~` for the home folder. */
  dir: string
  /** The checked-out branch; null outside a repository or on a detached head. */
  branch: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'footer-where': {
      where: Where | null
    }
  }
}
