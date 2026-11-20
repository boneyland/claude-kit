// One prompt of the main conversation: its transcript row id and what it says.
export type Prompt = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-index': {
      prompts: Shaped<Prompt[]>
      query: string
      // The prompt the last jump went to, where Next and Previous step from.
      cursor: string
      // Whether the pane is up, for the footer button's label.
      isOpen: boolean
    }
  }
}
