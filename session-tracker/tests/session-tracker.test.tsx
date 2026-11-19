import { expect, mock, test } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import type { TrackerSnapshot } from '../types'

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR
const HOME = 'C:/Users/me'
const PROJECTS = `${HOME}/.claude/projects`
const APPS = `${HOME}/AppData/Roaming/Claude/claude-code-sessions`
const TOOL = 'mcp__session-tracker__overview'

const PANE = {
  plugin: 'session-tracker',
  component: 'Pane',
  requestId: 'session-tracker',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const rows = (...all: object[]): string => all.map(row => JSON.stringify(row)).join('\n')

// What Claude has recorded on this pretend machine: a session in a
// repository, which the desktop app knows too, and one outside any.
const FILES: Record<string, string> = {
  [`${PROJECTS}/p1/s-self.jsonl`]: rows(
    {
      type: 'user',
      cwd: 'C:\\r',
      gitBranch: 'feature',
      timestamp: new Date(NOW - HOUR).toISOString(),
    },
    { type: 'custom-title', customTitle: 'Transcript title' },
  ),
  [`${PROJECTS}/p2/s-loose.jsonl`]: rows(
    {
      type: 'assistant',
      cwd: 'C:\\Users\\me',
      gitBranch: '',
      timestamp: new Date(NOW - 2 * DAY).toISOString(),
    },
    { type: 'ai-title', aiTitle: 'Loose chat' },
  ),
  [`${APPS}/acc/org/local_1.json`]: JSON.stringify({
    sessionId: 'local_1',
    cliSessionId: 's-self',
    title: 'Tracker mod',
    cwd: 'C:\\r',
    isArchived: false,
    lastActivityAt: NOW - HOUR / 2,
    prs: [
      {
        prNumber: 2,
        url: 'https://github.com/me/r/pull/2',
        branch: 'feature',
        state: 'open',
        repo: 'me/r',
      },
    ],
  }),
}

const folder = (name: string): FsEntry => ({
  name,
  kind: 'dir',
  size: 0,
  mtimeMs: 0,
  isLink: false,
})

const fileIn = (dir: string, name: string, mtimeMs: number): FsEntry => ({
  name,
  kind: 'file',
  size: FILES[`${dir}/${name}`]?.length ?? 0,
  mtimeMs,
  isLink: false,
})

const FOLDERS: Record<string, FsEntry[]> = {
  [PROJECTS]: [folder('p1'), folder('p2')],
  [`${PROJECTS}/p1`]: [
    fileIn(`${PROJECTS}/p1`, 's-self.jsonl', NOW - HOUR),
    // Older than the window: never read.
    fileIn(`${PROJECTS}/p1`, 's-ancient.jsonl', NOW - 60 * DAY),
  ],
  [`${PROJECTS}/p2`]: [fileIn(`${PROJECTS}/p2`, 's-loose.jsonl', NOW - 2 * DAY)],
  [APPS]: [folder('acc')],
  [`${APPS}/acc`]: [folder('org')],
  [`${APPS}/acc/org`]: [fileIn(`${APPS}/acc/org`, 'local_1.json', NOW - HOUR / 2)],
}

const unix = (ms: number): number => Math.round(ms / 1000)

/** The engine hands a hook the path as the platform spells it. */
const flat = (path: string): string => path.replace(/\\/g, '/')

/** What git prints in the pretend repository `C:/r`. */
const git = (argv: readonly string[]): string | undefined => {
  const [, , cwd = '', verb, ...rest] = argv
  const isInRepo = cwd.replace(/\\/g, '/').toLowerCase().startsWith('c:/r')

  if (!isInRepo) {
    return undefined
  }

  if (verb === 'rev-parse') {
    return 'C:/r\nC:/r/.git\n'
  }

  if (verb === 'worktree') {
    return 'worktree C:/r\nHEAD 1111111\nbranch refs/heads/feature\n\n'
  }

  if (verb === 'for-each-ref' && rest.includes('refs/remotes/origin/HEAD')) {
    return 'refs/remotes/origin/HEAD\torigin/main\nrefs/heads/main\t\n'
  }

  if (verb === 'for-each-ref') {
    return [
      `main\torigin/main\t\t${unix(NOW - DAY)}\t\t0 0`,
      `feature\torigin/feature\tahead 2\t${unix(NOW - 10 * DAY)}\tC:/r\t2 0`,
      `old\torigin/old\t\t${unix(NOW - 40 * DAY)}\t\t0 5`,
      '',
    ].join('\n')
  }

  return verb === 'status' ? ' M a.ts\n?? notes.pdf\n' : undefined
}

// Nothing sits beneath the mod in a test: each hook here stands for the engine.
const world = (on: On, given: { store?: Record<string, unknown>; isPaneUp?: boolean } = {}) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>(Object.entries(given.store ?? {}))
  const gitCalls: (readonly string[])[] = []
  const gitEnv: (Record<string, string> | undefined)[] = []
  const fills: string[] = []
  const read: string[] = []
  let status: string | undefined

  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's-self' }))
  on('command.register', () => ({ value: { command: 'session-tracker' } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({
    value:
      given.isPaneUp === true
        ? [
            {
              id: 'session-tracker',
              title: 'Sessions',
              isShown: true,
              isFocused: false,
              isPlaced: true,
            },
          ]
        : [],
  }))
  on('ui.status', (_, e) => {
    status = e.text

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    fills.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('env.get', (_, e) => ({
    value: { USERPROFILE: HOME, APPDATA: `${HOME}/AppData/Roaming` }[e.name],
  }))
  on('fs.list', (_, e) => ({ value: FOLDERS[flat(e.path)] ?? [] }))
  on('fs.exists', (_, e) => ({ value: flat(e.path) === HOME }))
  on('fs.read', (_, e) => {
    read.push(flat(e.path))

    return { value: FILES[flat(e.path)] ?? '' }
  })
  on('process.run', (_, e) => {
    gitCalls.push(e.argv)
    gitEnv.push(e.init?.env)

    const out = git(e.argv)

    return {
      value: {
        exitCode: out === undefined ? 128 : 0,
        stdout: out ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  return {
    clock,
    store,
    gitCalls,
    gitEnv,
    fills,
    read,
    status: () => status,
    snapshot: () => store.get('snapshot-1') as TrackerSnapshot | undefined,
  }
}

type Dollar = Parameters<TestBody>[0]

const start = ($: Dollar) =>
  $.session.start({ cwd: 'C:\\r', surface: 'desktop', isInteractive: true })

/** `/session-tracker <args>` as the person types it at the prompt. */
const run = ($: Dollar, args: string) =>
  $.command.run({
    command: 'session-tracker',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

test('a scan reads the sessions and git, and changes nothing', async ($, on) => {
  const { gitCalls, gitEnv, read, snapshot, status } = world(on)

  await start($)

  const listed = await run($, 'list')

  expect(listed.text).toMatch(/2 sessions in 1 repository\. 1 to tidy\./)
  expect(listed.text).toMatch(/r: C:\/r \(default branch main\)/)
  // The session's own unpushed work is no flag while it is being worked on.
  expect(listed.text).toMatch(
    /checked out feature: main checkout, 1 changed, 1 untracked, 2 to push, r#2 open/,
  )
  // The app's title and PR state lie over what the transcript says.
  expect(listed.text).toMatch(
    /session "Tracker mod" \(this session, 30 min ago, me\/r#2 open, s-self\)/,
  )
  expect(listed.text).toMatch(
    /branch old: merged into main, last commit 6 wk ago\n\s+to tidy: merged: the branch can be deleted/,
  )
  expect(listed.text).toMatch(
    /Outside a git repository:\n\s+session "Loose chat" in C:\\Users\\me \(2 d ago, s-loose\)/,
  )

  expect(snapshot()?.scannedAt).toBe(NOW)
  expect(status()).toBeUndefined()
  // A transcript older than the window is never opened.
  expect(read.some(path => path.includes('s-ancient'))).toBe(false)

  // Every git call is a read, and none takes a lock a session's own git wants.
  expect(gitCalls.length).toBeGreaterThan(0)
  expect(gitCalls.every(argv => argv[0] === 'git' && argv[1] === '-C')).toBe(true)
  expect([...new Set(gitCalls.map(argv => argv.slice(3, 5).join(' ')))].sort()).toEqual([
    'for-each-ref --format=%(refname)%09%(symref:short)',
    'for-each-ref --format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(committerdate:unix)%09%(worktreepath)%09%(ahead-behind:origin/main)',
    'rev-parse --path-format=absolute',
    'status --porcelain',
    'worktree list',
  ])
  expect(gitEnv.every(env => env?.GIT_OPTIONAL_LOCKS === '0')).toBe(true)
})

test('the pane lists repositories, branches and sessions on every surface', async ($, on) => {
  const { fills } = world(on)

  await start($)
  await run($, 'list')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /2 sessions · 1 repo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 to tidy$/ })).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: /feature main checkout · 1 changed, 1 untracked · 2 to push · r#2 open/ }),
    ).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: /Tracker mod this session · 30 min ago/ }),
    ).toBeDefined()
    // A PR is a link, named with its repository.
    expect(await ui.find({ type: 'Link', text: /r#2 open/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~ merged: the branch can be deleted/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Loose chat/ })).toBeDefined()

    // Only what needs attention: the merged branch stays, the rest goes.
    await ui.press({ key: 'filter' })
    expect(await ui.find({ type: 'Text', text: /Tracker mod/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Loose chat/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /~ merged: the branch can be deleted/ })).toBeDefined()
    await ui.press({ key: 'filter' })
    expect(await ui.find({ type: 'Text', text: /Tracker mod/ })).toBeDefined()

    // The clean-up is a draft in the prompt box: the mod deletes nothing.
    await ui.press({ key: 'tidy' })
    expect(fills.at(-1)).toMatch(/- In C:\/r: delete the local branch old \(merged into main\)\./)
    await ui.unmount()
  }
})

test('the model asks for the overview through the tool', async ($, on) => {
  world(on)
  await start($)

  const all = await $.tool.run({ tool: TOOL, tool_use_id: 'tu-1' })

  expect(String(all.result)).toMatch(/2 sessions in 1 repository/)

  const none = await $.tool.run({ tool: TOOL, tool_use_id: 'tu-2', repo: 'nowhere' })

  expect(String(none.result)).toMatch(/0 sessions in 0 repositories\. Nothing needs attention\./)
})

test('an open pane is read again when its snapshot is old; a closed one never', async ($, on) => {
  const shut = world(on)

  await start($)
  await shut.clock.advance(20 * 60_000)
  expect(shut.gitCalls).toHaveLength(0)
})

test('an open pane keeps itself current', async ($, on) => {
  const open = world(on, { isPaneUp: true })

  await start($)
  await run($, 'refresh')
  await open.clock.settle()

  const first = open.gitCalls.length

  expect(first).toBeGreaterThan(0)
  await open.clock.advance(3 * 60_000)
  expect(open.gitCalls).toHaveLength(first)
  await open.clock.advance(3 * 60_000)
  expect(open.gitCalls.length).toBeGreaterThan(first)
})

test('a new session starts from the snapshot another one stored', async ($, on) => {
  const stored: TrackerSnapshot = {
    scannedAt: NOW - 10 * 60_000,
    repos: [],
    sessions: [
      {
        id: 's-other',
        title: 'From another session',
        cwd: 'C:\\Users\\me',
        branch: '',
        lastActiveAt: NOW - HOUR,
        isArchived: false,
        repo: '',
        worktree: '',
        isFolderGone: false,
        prs: [],
      },
    ],
  }
  const { gitCalls } = world(on, { store: { 'snapshot-1': stored } })

  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /1 session · 0 repos · read 10 min ago/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /From another session/ })).toBeDefined()
  expect(gitCalls).toHaveLength(0)
  await ui.unmount()
})

test('a stored value of another shape is declined', async ($, on) => {
  world(on, { store: { 'snapshot-1': { sessions: 'not a list' } } })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /0 sessions · 0 repos · not read yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Press Refresh/ })).toBeDefined()
  await ui.unmount()
})

test('the widget shows the counts at a glance', async ($, on) => {
  world(on)
  await start($)
  await run($, 'list')

  const ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, placement: 'widget' },
    surface: 'desktop',
  })

  expect(await ui.find({ type: 'Text', text: /2 sessions · 1 repo/ })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})
