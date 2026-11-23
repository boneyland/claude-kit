import { expect, test } from 'claude-code/testing'

import { commandRefusal, isProtectedPath, refusal } from './fence'

const F = { branch: 'feat', number: 12 }
const refused = (command: string) => commandRefusal(command, F) !== null

test('history rewrites and force-pushes are refused; a plain push of the PR branch is not', () => {
  for (const c of [
    'git push --force',
    'git push -f origin feat',
    'git push --force-with-lease',
    'git push origin +feat',
    'git push origin :feat',
    'git push --delete origin feat',
    'git push origin main',
    'git push origin HEAD:main',
    'git push --tags',
    'git rebase main',
    'git commit --amend -m x',
    'git reset --hard origin/feat',
    'git -C sub push -f',
    'cd x && git push --force',
  ])
    expect([c, refused(c)]).toEqual([c, true])
  for (const c of ['git push', 'git push origin', 'git push origin feat', 'git push -u origin feat', 'git push origin HEAD:feat', 'git push origin refs/heads/feat', 'git push -n origin feat', 'git reset HEAD file.ts', 'git commit -m "fix: x"'])
    expect([c, refused(c)]).toEqual([c, false])
})

test("the user's uncommitted work and git hooks are left alone", () => {
  for (const c of ['git stash', 'git stash push', 'git clean -fd', 'git restore src/a.ts', 'git checkout -- src/a.ts', 'git checkout .', 'git commit --no-verify -m x', 'git commit -n -m x', 'git push --no-verify', 'git branch -D old', 'git config user.email x@y'])
    expect([c, refused(c)]).toEqual([c, true])
  for (const c of ['git stash list', 'git restore --staged a.ts', 'git checkout --theirs a.ts', 'git checkout feat', 'git checkout -b fix', 'git config user.email', 'git config --get user.name', 'git status', 'git merge origin/main'])
    expect([c, refused(c)]).toEqual([c, false])
})

test('merging, closing or editing the PR and settings endpoints are refused', () => {
  for (const c of ['gh pr merge 12 --squash', 'gh pr close 12', 'gh pr edit 12 --base dev', 'gh pr review --approve', 'gh api -X PUT repos/a/b/pulls/12/merge', 'gh api repos/a/b/branches/main/protection', 'gh secret set X'])
    expect([c, refused(c)]).toEqual([c, true])
  for (const c of ['gh pr view 12', 'gh pr checks 12', 'gh run view 1 --log-failed', 'gh run rerun 1 --failed', 'gh run list --branch main --limit 5', 'gh api repos/a/b/pulls/12'])
    expect([c, refused(c)]).toEqual([c, false])
})

test('files that control Claude Code or git are not edited', () => {
  for (const p of ['.claude/settings.json', '/r/.claude/settings.local.json', '.mcp.json', '.git/hooks/pre-commit', '.git/config', '.husky/pre-push', '.claude/hooks/x.sh'])
    expect([p, isProtectedPath(p)]).toEqual([p, true])
  for (const p of ['src/settings.json', 'docs/.claude.md', 'CLAUDE.md', '.github/workflows/ci.yml', '.gitignore'])
    expect([p, isProtectedPath(p)]).toEqual([p, false])
  expect(refused('echo x > .git/hooks/pre-commit')).toBe(true)
  expect(refusal({ tool: 'Edit', file_path: '/r/.mcp.json' }, F)).toContain('pr-watch refused this while it is fixing PR #12')
  expect(refusal({ tool: 'Edit', file_path: '/r/src/a.ts' }, F)).toBe(null)
  expect(refusal({ tool: 'Bash', command: 'npm test' }, F)).toBe(null)
})
