import { expect, test } from 'claude-code/testing'

import type {
  TrackedBranch,
  TrackedRepo,
  TrackedSession,
  TrackedWorktree,
  TrackerSnapshot,
} from '../types'

import {
  DAY,
  HOUR,
  countStatus,
  joinSessions,
  overviewOf,
  overviewText,
  parseBranches,
  parseDefault,
  parseWorktrees,
  pathKey,
  readAppRecord,
  readTail,
  tidyDraft,
} from '../hooks/model'

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)

test('git worktree list is read: main first, a gone folder, no bare entry', () => {
  const trees = parseWorktrees(
    [
      'worktree C:/r',
      'HEAD 1111111',
      'branch refs/heads/feature/a',
      '',
      'worktree C:/r-wt',
      'HEAD 2222222',
      'detached',
      '',
      'worktree C:/gone',
      'HEAD 3333333',
      'branch refs/heads/old',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\r\n'),
  )

  expect(trees.map(tree => [tree.path, tree.branch, tree.isMain, tree.isMissing])).toEqual([
    ['C:/r', 'feature/a', true, false],
    ['C:/r-wt', '', false, false],
    ['C:/gone', 'old', false, true],
  ])
  expect(parseWorktrees('worktree /srv/r.git\nbare\n\nworktree /srv/wt\nbranch refs/heads/x\n')).toHaveLength(1)
})

test('the default branch is the remote head, else a local main or master', () => {
  expect(
    parseDefault('refs/remotes/origin/HEAD\torigin/trunk\nrefs/heads/main\t\n'),
  ).toEqual({ branch: 'trunk', compare: 'origin/trunk' })
  expect(parseDefault('refs/heads/master\t\n')).toEqual({ branch: 'master', compare: 'master' })
  expect(parseDefault('')).toEqual({ branch: '', compare: '' })
})

test('branches are read with what is unpushed and what the default branch lacks', () => {
  const branches = parseBranches(
    [
      'main\torigin/main\tbehind 39\t1793346725\tC:/r\t0 39',
      'work\torigin/work\tahead 2, behind 1\t1793000000\t\t5 3',
      'gone\torigin/gone\tgone\t1790000000\t\t1 0',
      'local\t\t\t1790000000\t\t',
    ].join('\n'),
  )

  expect(branches.map(one => [one.name, one.ahead, one.behind, one.isUpstreamGone, one.aheadOfDefault, one.worktree])).toEqual([
    ['main', 0, 39, false, 0, 'C:/r'],
    ['work', 2, 1, false, 5, ''],
    ['gone', 0, 0, true, 1, ''],
    // An older git prints no comparison: unknown, never zero.
    ['local', 0, 0, false, -1, ''],
  ])
  expect(branches[0]?.lastCommitAt).toBe(1793346725000)
})

test('git status counts changed files apart from untracked ones', () => {
  expect(countStatus(' M a.ts\nA  b.ts\n?? notes.pdf\n?? x/\n')).toEqual({
    modified: 2,
    untracked: 2,
  })
  expect(countStatus('')).toEqual({ modified: 0, untracked: 0 })
})

test("a transcript's end says where the session is now and what it is called", () => {
  const rows = [
    'cut-off line that is not JSON',
    JSON.stringify({ type: 'user', cwd: 'C:\\r', gitBranch: 'old', timestamp: '2026-11-19T09:00:00Z' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'A summary' }),
    JSON.stringify({ type: 'pr-link', prNumber: 7, prUrl: 'https://github.com/me/r/pull/7', prRepository: 'me/r' }),
    JSON.stringify({ type: 'pr-link', prNumber: 8, prUrl: 'javascript:alert(1)' }),
    JSON.stringify({ type: 'assistant', cwd: 'C:\\r-wt', gitBranch: 'feature/a', timestamp: '2026-11-19T11:00:00Z' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Named  by\nthe person' }),
    JSON.stringify({ type: 'api-request-blob', cwd: 'C:\\wrong', message: 'x'.repeat(70_000) }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'do the thing' }),
  ]
  const tail = readTail(rows.join('\n'), true)

  expect(tail).toEqual({
    cwd: 'C:\\r-wt',
    branch: 'feature/a',
    title: 'Named by the person',
    lastAt: Date.parse('2026-11-19T11:00:00Z'),
    prs: [{ number: 7, url: 'https://github.com/me/r/pull/7', state: '', branch: '', repo: 'me/r' }],
  })
  expect(readTail('', false)).toEqual({ cwd: '', branch: '', title: '', lastAt: 0, prs: [] })
})

test("the app's record is laid over the transcript: its title and PR state win", () => {
  const app = readAppRecord(
    JSON.stringify({
      sessionId: 'local_1',
      cliSessionId: 's1',
      title: 'App title',
      cwd: 'C:\\r',
      isArchived: true,
      lastActivityAt: NOW - HOUR,
      prs: [{ prNumber: 7, url: 'https://github.com/me/r/pull/7', branch: 'feature/a', state: 'MERGED', repo: 'me/r' }],
    }),
  )

  expect(readAppRecord('not json')).toBeUndefined()
  expect(readAppRecord('{}')).toBeUndefined()

  const sessions = joinSessions(
    [
      {
        id: 's1',
        mtimeMs: NOW - 2 * HOUR,
        cwd: 'C:\\r-wt',
        branch: 'feature/a',
        title: 'Transcript title',
        lastAt: NOW - 2 * HOUR,
        prs: [
          { number: 7, url: 'https://github.com/me/r/pull/7', state: '', branch: '', repo: 'me/r' },
          { number: 9, url: 'https://github.com/me/r/pull/9', state: '', branch: '', repo: 'me/r' },
        ],
      },
      { id: 'old', mtimeMs: NOW - 30 * DAY, cwd: 'C:\\r', branch: '', title: '', lastAt: 0, prs: [] },
    ],
    app === undefined ? [] : [app],
    NOW - 14 * DAY,
  )

  expect(sessions).toEqual([
    {
      id: 's1',
      title: 'App title',
      // The transcript knows the folder the session moved to.
      cwd: 'C:\\r-wt',
      branch: 'feature/a',
      lastActiveAt: NOW - HOUR,
      isArchived: true,
      prs: [
        { number: 7, url: 'https://github.com/me/r/pull/7', state: 'merged', branch: 'feature/a', repo: 'me/r' },
        { number: 9, url: 'https://github.com/me/r/pull/9', state: '', branch: '', repo: 'me/r' },
      ],
    },
  ])
})

const branch = (over: Partial<TrackedBranch> & { name: string }): TrackedBranch => ({
  upstream: `origin/${over.name}`,
  isUpstreamGone: false,
  ahead: 0,
  behind: 0,
  aheadOfDefault: 1,
  lastCommitAt: NOW - HOUR,
  worktree: '',
  ...over,
})

const tree = (over: Partial<TrackedWorktree> & { path: string }): TrackedWorktree => ({
  branch: '',
  isMain: false,
  isMissing: false,
  modified: 0,
  untracked: 0,
  ...over,
})

const session = (over: Partial<TrackedSession> & { id: string }): TrackedSession => ({
  title: over.id,
  cwd: 'C:\\r',
  branch: '',
  lastActiveAt: NOW - HOUR,
  isArchived: false,
  repo: 'C:/r',
  worktree: 'C:/r',
  isFolderGone: false,
  prs: [],
  ...over,
})

const REPO: TrackedRepo = {
  root: 'C:/r',
  name: 'r',
  defaultBranch: 'main',
  worktrees: [
    tree({ path: 'C:/r', isMain: true, branch: 'fresh', modified: 4 }),
    tree({ path: 'C:/r-done', branch: 'done' }),
    tree({ path: 'C:/r-busy', branch: 'busy', modified: 2 }),
    tree({ path: 'C:/r-lost', branch: 'lost', isMissing: true }),
  ],
  branches: [
    branch({ name: 'main', aheadOfDefault: 0 }),
    // Just made: nothing committed yet, never pushed. Work in progress, no flag.
    branch({ name: 'fresh', upstream: '', aheadOfDefault: 0 }),
    branch({ name: 'done', aheadOfDefault: 0, lastCommitAt: NOW - 10 * DAY }),
    branch({ name: 'busy', ahead: 3, aheadOfDefault: 3 }),
    branch({ name: 'lost', lastCommitAt: NOW - 10 * DAY }),
    branch({ name: 'forgotten', ahead: 2, aheadOfDefault: 2, lastCommitAt: NOW - 20 * DAY }),
    branch({ name: 'local-only', upstream: '', aheadOfDefault: 5, lastCommitAt: NOW - 9 * DAY }),
    branch({ name: 'squashed', isUpstreamGone: true, aheadOfDefault: 4, lastCommitAt: NOW - 5 * DAY }),
    branch({ name: 'vanished', isUpstreamGone: true, aheadOfDefault: 2, lastCommitAt: NOW - 5 * DAY }),
    branch({ name: 'leftover', upstream: '', aheadOfDefault: 0, lastCommitAt: NOW - 40 * DAY }),
  ],
}

const SNAPSHOT: TrackerSnapshot = {
  scannedAt: NOW,
  repos: [REPO],
  sessions: [
    session({ id: 'self', branch: 'fresh' }),
    session({ id: 'in-busy', cwd: 'C:\\r-busy', worktree: 'C:/r-busy', branch: 'busy' }),
    // It ran in the main checkout while that was on another branch.
    session({
      id: 'earlier',
      branch: 'squashed',
      lastActiveAt: NOW - 5 * DAY,
      prs: [
        { number: 3, url: 'https://github.com/me/r/pull/3', state: 'merged', branch: 'squashed', repo: 'me/r' },
        // The same branch name in another repository says nothing here.
        { number: 4, url: 'https://github.com/me/other/pull/4', state: 'merged', branch: 'vanished', repo: 'me/other' },
      ],
    }),
    session({ id: 'elsewhere', cwd: 'C:\\Users\\me', repo: '', worktree: '' }),
    session({ id: 'removed', cwd: 'C:\\r\\.claude\\worktrees\\x', worktree: 'C:\\r\\.claude\\worktrees\\x', isFolderGone: true }),
  ],
}

test('only forgotten work is at risk; what is merged or empty is to tidy', () => {
  const overview = overviewOf(SNAPSHOT, NOW, 3)
  const flagsOf = (name: string) =>
    overview.repos[0]?.nodes.find(node => node.name === name)?.flags.map(flag => `${flag.kind}: ${flag.text}`)

  // Being worked on: uncommitted and unpushed, and no flag.
  expect(flagsOf('fresh')).toEqual([])
  expect(flagsOf('busy')).toEqual([])
  expect(flagsOf('main')).toEqual([])

  expect(flagsOf('forgotten')).toEqual(['risk: 2 commits not pushed, untouched for 20 days'])
  expect(flagsOf('local-only')).toEqual(['risk: 5 commits never pushed, untouched for 9 days'])

  expect(flagsOf('done')).toEqual(['tidy: branch merged and folder clean: the worktree can be removed'])
  expect(flagsOf('lost')).toEqual(['tidy: its folder is gone'])
  // A squash merge leaves commits the default branch lacks: the PR says merged.
  expect(flagsOf('squashed')).toEqual(['tidy: merged: the branch can be deleted'])
  expect(flagsOf('vanished')).toEqual(['tidy: its remote branch is gone: merged or deleted there'])
  expect(flagsOf('leftover')).toEqual(['tidy: no commits of its own: the branch can be deleted'])

  expect([overview.risk, overview.tidy]).toEqual([2, 5])
})

test('sessions stand by the working tree or branch they worked on', () => {
  const view = overviewOf(SNAPSHOT, NOW, 3).repos[0]
  const on = (name: string) => view?.nodes.find(node => node.name === name)?.sessions.map(one => one.id)

  expect(on('fresh')).toEqual(['self'])
  expect(on('busy')).toEqual(['in-busy'])
  expect(on('squashed')).toEqual(['earlier'])
  expect(view?.strays.map(one => one.id)).toEqual(['removed'])
  expect(overviewOf(SNAPSHOT, NOW, 3).loose.map(one => one.id)).toEqual(['elsewhere'])
  // The main checkout leads, then the other working trees, then flagged branches.
  expect(view?.nodes.slice(0, 2).map(node => node.name)).toEqual(['fresh', 'busy'])
})

test('the tidy draft asks only for steps that lose nothing, each with its repository', () => {
  const draft = tidyDraft(overviewOf(SNAPSHOT, NOW, 3))

  expect(draft.split('\n').slice(1)).toEqual([
    '- In C:/r: remove the worktree C:/r-done and delete the branch done (merged into main, nothing uncommitted).',
    '- In C:/r: run "git worktree prune" (the worktree folder C:/r-lost is gone).',
    '- In C:/r: delete the local branch squashed (merged into main).',
    '- In C:/r: check whether the branch vanished was merged (its remote branch is gone), and delete the local branch if it was.',
    '- In C:/r: delete the local branch leftover (it has no commit that main lacks).',
  ])
  expect(draft).not.toMatch(/forgotten|local-only|busy|fresh/)
  expect(tidyDraft(overviewOf({ ...SNAPSHOT, repos: [] }, NOW, 3))).toBe('')
})

test('the listing names every session with its place, and each PR with its repository', () => {
  const text = overviewText(SNAPSHOT, overviewOf(SNAPSHOT, NOW, 3), NOW, 'self')

  expect(text).toMatch(/5 sessions in 1 repository\. 2 at risk · 5 to tidy\./)
  expect(text).toMatch(/checked out fresh: main checkout, 4 changed, no commits of its own/)
  expect(text).toMatch(/session "self" \(this session, 1 h ago, self\)/)
  expect(text).toMatch(/AT RISK: 2 commits not pushed, untouched for 20 days/)
  expect(text).toMatch(/session "earlier" \(5 d ago, me\/r#3 merged, me\/other#4 merged, earlier\)/)
  expect(text).toMatch(/Outside a git repository:\n\s+session "elsewhere" in C:\\Users\\me/)
})

test('a path is compared whatever way it is spelled', () => {
  expect(pathKey('c:\\Users\\Me\\r\\')).toBe(pathKey('C:/Users/me/r'))
  expect(pathKey('/home/Me/r/')).toBe('/home/Me/r')
})
