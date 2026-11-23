// While a turn that pr-watch started runs, some tool calls are refused outright,
// not just asked against in the prompt: rewriting pushed history, pushing anywhere
// but the PR's branch, merging or closing the PR, touching the user's uncommitted
// work, skipping git hooks, and editing what controls Claude Code or git.
// Pure: the engine's tool.call hook asks `refusal` and denies with its reason.

export type Fence = { branch: string; number: number }

// Shell segments: split on the operators that start another command. Quotes are
// not parsed: a quoted `&&` splits too, which only ever makes a rule stricter.
const segments = (command: string) =>
  command
    .split(/&&|\|\||[;|\n]|\$\(|`/)
    .map(s => s.trim())
    .filter(Boolean)

// The words of a segment, leading `VAR=value` assignments, `sudo`, `command`
// and `env` dropped; quotes stripped from each word.
const words = (segment: string) => {
  const all = segment.split(/\s+/).map(w => w.replace(/^['"]|['"]$/g, ''))
  let i = 0
  while (i < all.length && (/^\w+=/.test(all[i]!) || ['sudo', 'command', 'env', 'exec'].includes(all[i]!))) i++
  return all.slice(i)
}

// `git [-C dir] [-c k=v] [--opt] <sub> ...` -> [sub, ...rest], else null.
const gitArgs = (w: string[]): string[] | null => {
  if (w[0] !== 'git' && !/\/git$/.test(w[0] ?? '')) return null
  let i = 1
  while (i < w.length && w[i]!.startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(w[i]!)) i += 2
    else i += 1
  }
  return w.slice(i)
}

const ghArgs = (w: string[]): string[] | null => (w[0] === 'gh' || /\/gh$/.test(w[0] ?? '') ? w.slice(1) : null)

const has = (args: string[], ...flags: string[]) => args.some(a => flags.includes(a) || flags.some(f => f.endsWith('=') && a.startsWith(f)))

// Why a git command is refused, or null.
const gitRefusal = (args: string[], fence: Fence): string | null => {
  const [sub, ...rest] = args
  // -n is commit's --no-verify, but push's --dry-run.
  if ((sub === 'commit' && has(rest, '--no-verify', '-n')) || ((sub === 'push' || sub === 'merge') && has(rest, '--no-verify')))
    return "skips the repository's git hooks"
  switch (sub) {
    case 'push': {
      if (has(rest, '--force', '-f', '--force-with-lease', '--force-with-lease=', '--force-if-includes', '--mirror', '--delete', '-d', '--prune', '--tags', '--all'))
        return 'force-pushes, deletes or pushes more than the PR branch'
      const positional = rest.filter(a => !a.startsWith('-'))
      // `git push` and `git push origin` push the current branch; a refspec must name the PR's.
      for (const spec of positional.slice(1)) {
        if (spec.startsWith('+')) return 'force-pushes (a + refspec)'
        if (spec.startsWith(':')) return 'deletes a remote branch'
        const dst = (spec.includes(':') ? spec.split(':')[1]! : spec).replace(/^refs\/heads\//, '')
        if (dst !== fence.branch && dst !== 'HEAD') return `pushes to \`${dst}\`, not the PR branch \`${fence.branch}\``
      }
      return null
    }
    case 'rebase':
      return 'rewrites history (rebase)'
    case 'commit':
      return has(rest, '--amend') ? 'rewrites a commit (--amend)' : null
    case 'reset':
      return has(rest, '--hard', '--merge', '--keep') ? 'discards work (reset --hard)' : null
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show' ? null : "stashes the user's uncommitted work"
    case 'clean':
      return 'deletes untracked files (clean)'
    case 'restore': {
      // Unstaging, or taking one side of a conflict, keeps the user's work.
      const isUnstage = has(rest, '--staged', '-S') && !has(rest, '--worktree', '-W')
      return isUnstage || has(rest, '--ours', '--theirs') ? null : 'discards uncommitted changes (restore)'
    }
    case 'checkout': {
      if (has(rest, '--ours', '--theirs')) return null
      if (has(rest, '-f', '--force')) return 'discards uncommitted changes (checkout --force)'
      return rest.includes('--') || rest.includes('.') ? 'discards uncommitted changes (checkout -- <path>)' : null
    }
    case 'branch':
      return has(rest, '-D', '-d', '--delete', '-M', '-m', '--move', '-f', '--force') ? 'deletes, moves or resets a branch' : null
    case 'tag':
      return rest.length === 0 || has(rest, '-l', '--list') ? null : 'creates or deletes a tag'
    case 'update-ref':
    case 'filter-branch':
    case 'filter-repo':
    case 'replace':
      return 'rewrites refs or history'
    case 'config':
      return has(rest, '--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope') ||
        (rest.filter(a => !a.startsWith('-')).length === 1)
        ? null
        : "changes git's settings"
    default:
      return null
  }
}

// Why a gh command is refused, or null.
const ghRefusal = (args: string[]): string | null => {
  const [noun, verb, ...rest] = args
  if (noun === 'pr' && ['merge', 'close', 'reopen', 'edit', 'ready', 'lock', 'unlock'].includes(verb ?? ''))
    return `changes the pull request itself (gh pr ${verb})`
  if (noun === 'pr' && verb === 'review') return 'reviews the pull request'
  if (noun === 'repo' && ['delete', 'edit', 'archive', 'rename'].includes(verb ?? '')) return 'changes the repository'
  if (noun === 'secret' || noun === 'variable' || noun === 'ruleset') return 'changes repository settings'
  if (noun === 'api') {
    const all = [verb ?? '', ...rest]
    const method = all.findIndex(a => a === '-X' || a === '--method')
    const m = method >= 0 ? (all[method + 1] ?? '').toUpperCase() : all.find(a => /^(-X|--method=)/.test(a))?.replace(/^(-X|--method=)/, '').toUpperCase()
    if (all.some(a => /\/merge(\b|$)|\/protection\b|\/hooks\b|\/keys\b|\/secrets\b/.test(a))) return 'reaches a merge or settings endpoint'
    if (m === 'DELETE') return 'deletes through the API'
  }
  return null
}

// Paths a pr-watch turn never edits: what controls Claude Code, MCP or git.
const PROTECTED = [
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)\.git\//,
  /(^|\/)\.git$/,
  /(^|\/)\.gitconfig$/,
  /(^|\/)\.claude\/(hooks|skills|commands|agents)\//,
  /(^|\/)\.husky\//,
  /(^|\/)\.githooks\//,
]

export const isProtectedPath = (path: string) => PROTECTED.some(re => re.test(path.replace(/\\/g, '/')))

// Why a shell command is refused under the fence, or null.
export function commandRefusal(command: string, fence: Fence): string | null {
  for (const segment of segments(command)) {
    const w = words(segment)
    const git = gitArgs(w)
    const why = git ? gitRefusal(git, fence) : ghArgs(w) ? ghRefusal(ghArgs(w)!) : null
    if (why) return why
    // A redirect or copy into a protected path.
    const target = segment.match(/>{1,2}\s*(\S+)/)?.[1]
    if (target && isProtectedPath(target.replace(/^['"]|['"]$/g, ''))) return `writes to ${target}`
  }
  return null
}

// The tool call's refusal under the fence, as the model will read it, or null.
export function refusal(e: { tool: string } & Record<string, unknown>, fence: Fence): string | null {
  let why: string | null = null
  if (e.tool === 'Bash' && typeof e.command === 'string') why = commandRefusal(e.command, fence)
  const path = e.file_path ?? e.notebook_path
  if ((e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit' || e.tool === 'MultiEdit') && typeof path === 'string' && isProtectedPath(path))
    why = `edits ${path}, which controls Claude Code or git`
  if (why === null) return null
  return `pr-watch refused this while it is fixing PR #${fence.number}: it ${why}. If the fix truly needs it, stop and tell the user what and why; they can do it themselves.`
}
