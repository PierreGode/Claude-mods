import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import type { TeamsTask } from '../types'

const NOW = Date.UTC(2026, 10, 19, 9, 0, 0)
const SEARCH = 'mcp__m365__chat_message_search'
const SCANNER = 'teams-tasks:scanner'

const PANE = {
  plugin: 'teams-tasks',
  component: 'Pane',
  requestId: 'teams-tasks',
  props: {
    title: 'Teams tasks',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const task = (over: Partial<TeamsTask>): TeamsTask => ({
  id: 't1',
  key: 'finance|1',
  title: 'Send the Q4 numbers to Anna',
  detail: 'Anna needs the Q4 revenue numbers before the board meeting.',
  from: 'Anna',
  chat: 'Finance',
  due: '2026-11-20',
  priority: 'high',
  link: '',
  messageAt: '2026-11-19T08:00:00Z',
  status: 'open',
  closedBy: '',
  createdAt: NOW - 1000,
  closedAt: 0,
  ...over,
})

type World = {
  tools?: { name: string; description: string; mcp: boolean }[]
  store?: Record<string, unknown>
}

// Nothing sits beneath the mod in a test: each hook here stands for the engine.
const world = (on: On, given: World = {}) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>(Object.entries(given.store ?? {}))
  const registered: { tools?: readonly string[]; model?: string }[] = []
  const spawned: { prompt: string; subagentType?: string }[] = []
  const toasts: string[] = []
  let status: string | undefined

  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    status = e.text

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'teams-tasks' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.list', () => ({
    value: given.tools ?? [
      { name: SEARCH, description: 'Search Microsoft Teams chat messages', mcp: true },
      { name: 'mcp__m365__outlook_email_search', description: 'Search mail', mcp: true },
      { name: 'Bash', description: 'Runs a command', mcp: false },
    ],
  }))
  on('agent.register', (_, e) => {
    registered.push(e)

    return { value: { agent: SCANNER } }
  })
  on('agent.spawn', (_, e) => {
    spawned.push(e)

    return { model: 'sonnet', agentId: 'scan-1' }
  })
  on('agent.list', () => ({
    value: [
      {
        id: 'scan-1',
        description: 'Teams task scan',
        type: SCANNER,
        status: 'running',
        kind: 'local_agent',
        taskStatus: 'running',
        label: 'Teams task scan',
        startTime: NOW,
        cwd: '/',
        tokenCount: 0,
        tokenSamples: [],
        hasRow: true,
      },
    ],
  }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return {
    clock,
    registered,
    spawned,
    store,
    toasts,
    status: () => status,
    tasks: () => (store.get('tasks') ?? []) as TeamsTask[],
  }
}

type Dollar = Parameters<TestBody>[0]

const start = ($: Dollar) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

/** `/teams-tasks <args>` as the person types it at the prompt. */
const run = ($: Dollar, args: string) =>
  $.command.run({
    command: 'teams-tasks',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

const answered = ($: Dollar, answer: string) =>
  $.turn.complete({
    agentId: 'scan-1',
    answer,
    reason: 'answer',
    durationMs: 1,
    isAborted: false,
    turnId: 'turn-1',
  })

const ANSWER = JSON.stringify({
  tasks: [
    {
      key: 'Finance|42',
      title: 'Send the Q4 numbers to Anna',
      detail: 'Anna needs them before the board meeting on Friday.',
      from: 'Anna',
      chat: 'Finance',
      due: '2026-11-20',
      priority: 'high',
      messageAt: '2026-11-19T08:00:00Z',
      link: 'https://teams.microsoft.com/l/message/42',
    },
    {
      key: 'Platform|7',
      title: 'Review the deploy PR',
      detail: 'Erik asked for a review today.',
      from: 'Erik',
      chat: 'Platform',
      due: '',
      priority: 'whatever',
      messageAt: '',
      link: 'javascript:alert(1)',
    },
  ],
  done: [],
  error: '',
})

test('a scan turns what Teams says into tasks in the pane, on every surface', async ($, on) => {
  const { registered, spawned, store, tasks, toasts, status } = world(on)

  await start($)

  const ran = await run($, 'scan')

  expect(ran.text).toMatch(/Reading your Teams conversations/)
  // The scanner gets the Teams read tool and nothing that writes or runs.
  expect(registered[0]?.tools).toEqual([SEARCH, 'ToolSearch'])
  expect(registered[0]?.model).toBe('sonnet')
  expect(spawned).toHaveLength(1)
  // The first scan looks back the three days the options default to.
  expect(spawned[0]?.prompt).toMatch(/Window: messages from 2026-11-16T09:00:00.000Z/)

  // Words ahead of the JSON (a warning, a preamble) are passed over.
  await answered($, `Here is the report.\n${ANSWER}`)

  expect(store.get('lastScanAt')).toBe(NOW)
  expect(toasts).toEqual(['2 new tasks from Teams'])
  expect(status()).toBe('Teams: 2 tasks')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /2 open/ })).toBeDefined()

    // Urgent first; a priority the mod does not know reads as normal.
    const titles = (
      await ui.findAll({ type: 'Text', text: /Q4 numbers|deploy PR/ })
    ).map(found => found.text)

    expect(titles).toEqual(['! Send the Q4 numbers to Anna', 'Review the deploy PR'])
    expect(
      await ui.find({ type: 'Text', text: /Anna · Finance · due 2026-11-20/ }),
    ).toBeDefined()
    await ui.unmount()
  }

  // Only an https link is kept as a link.
  expect(tasks().map(one => one.link)).toEqual([
    'https://teams.microsoft.com/l/message/42',
    '',
  ])
})

test('a second scan adds a task once and closes what Teams shows handled', async ($, on) => {
  const { spawned, tasks } = world(on, {
    store: { tasks: [task({})], lastScanAt: NOW - 3_600_000 },
  })

  await start($)
  await run($, 'scan')

  // The known task goes to the scanner, and the window opens at the last scan.
  expect(spawned[0]?.prompt).toMatch(/"id":"t1"/)
  expect(spawned[0]?.prompt).toMatch(/Window: messages from 2026-11-19T07:30:00.000Z/)

  await answered(
    $,
    JSON.stringify({
      tasks: [
        { key: 'FINANCE|1', title: 'Send Anna the numbers', from: 'Anna' },
        { key: 'Platform|9', title: 'Answer Erik about the outage', from: 'Erik' },
      ],
      done: ['t1'],
      error: '',
    }),
  )

  expect(tasks().map(one => [one.title, one.status, one.closedBy])).toEqual([
    ['Send the Q4 numbers to Anna', 'done', 'scan'],
    ['Answer Erik about the outage', 'open', ''],
  ])
})

test('Done, Dismiss and Reopen move a task, and the store keeps it', async ($, on) => {
  const two = [
    task({}),
    task({ id: 't2', key: 'p|2', title: 'Review the PR', priority: 'normal', due: '' }),
  ]
  const { store, tasks } = world(on, { store: { tasks: two } })

  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    store.set('tasks', two)
    await run($, '')

    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'done:t1' })
    await ui.press({ key: 'drop:t2' })
    expect(await ui.find({ type: 'Text', text: /0 open/ })).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: /Nothing to do from Teams/ }),
    ).toBeDefined()
    expect(tasks().map(one => [one.id, one.status, one.closedBy])).toEqual([
      ['t1', 'done', 'me'],
      ['t2', 'dismissed', 'me'],
    ])

    // A dismissed task is gone; a done one can come back. The list of done
    // tasks stays as the person left it, so it is opened only when shut.
    if ((await ui.find({ key: 'reopen:t1' })) === undefined) {
      await ui.press({ key: 'toggle-done' })
    }

    expect(await ui.find({ key: 'reopen:t2' })).toBeUndefined()
    await ui.press({ key: 'reopen:t1' })
    expect(await ui.find({ type: 'Text', text: /1 open/ })).toBeDefined()
    expect(tasks()[0]?.status).toBe('open')
    await ui.unmount()
  }
})

test('with no Teams tool connected the pane says so and no scan starts', async ($, on) => {
  const { spawned } = world(on, {
    tools: [
      {
        name: 'mcp__github__get_teams',
        description: 'Get the teams the user is a member of',
        mcp: true,
      },
      {
        name: 'mcp__m365__send_chat_message',
        description: 'Send a Microsoft Teams chat message',
        mcp: true,
      },
      { name: 'Bash', description: 'Runs a command', mcp: false },
    ],
  })

  await start($)

  const ran = await run($, 'scan')

  expect(ran.text).toMatch(/No tool that reads Teams is connected/)
  expect(spawned).toHaveLength(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(
    await ui.find({ type: 'Text', text: /No tool that reads Teams is connected/ }),
  ).toBeDefined()
  await ui.unmount()
})

test('a scan that could not read Teams says why and adds nothing', async ($, on) => {
  const { store, tasks } = world(on)

  await start($)
  await run($, 'scan')
  await answered($, '{"tasks":[],"done":[],"error":"The search tool was refused."}')

  expect(store.get('lastScanAt')).toBeUndefined()
  expect(tasks()).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(
    await ui.find({
      type: 'Text',
      text: /Teams could not be read: The search tool was refused\./,
    }),
  ).toBeDefined()
  await ui.unmount()
})

test("the scan's own Teams reads run unasked; nothing else is granted", async ($, on) => {
  world(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await start($)
  await run($, 'scan')

  // The scanner's call to the tool it was given.
  expect(
    (await $.tool.check({ tool: SEARCH, input: {}, agentId: 'scan-1' })).decision,
  ).toBe('allow')
  // The same tool from the main conversation, and another tool from the scanner.
  expect((await $.tool.check({ tool: SEARCH, input: {} })).decision).toBe('ask')
  expect(
    (await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, agentId: 'scan-1' }))
      .decision,
  ).toBe('ask')

  // Once the scan has answered, the grant is over.
  await answered($, '{"tasks":[],"done":[],"error":""}')
  expect(
    (await $.tool.check({ tool: SEARCH, input: {}, agentId: 'scan-1' })).decision,
  ).toBe('ask')
})

test('a rule that denies a Teams tool is not overridden for the scan', async ($, on) => {
  world(on)
  on('tool.check', () => ({ decision: 'deny', reason: 'a deny rule' }))
  await start($)
  await run($, 'scan')

  expect(
    (await $.tool.check({ tool: SEARCH, input: {}, agentId: 'scan-1' })).decision,
  ).toBe('deny')
})

test('a timer scans only when the last try is older than the interval', async ($, on) => {
  const { clock, spawned } = world(on, { store: { lastTryAt: NOW - 30 * 60_000 } })

  await start($)
  await clock.advance(21_000)
  expect(spawned).toHaveLength(0)

  await clock.advance(31 * 60_000)
  expect(spawned).toHaveLength(1)
})

test('/teams-tasks list prints the open tasks for the model to read', async ($, on) => {
  world(on, {
    store: { tasks: [task({}), task({ id: 't2', status: 'done', closedAt: NOW - 5 })] },
  })
  await start($)

  const ran = await run($, 'list')

  expect(ran.text).toMatch(/Open tasks from Teams \(1\)/)
  expect(ran.text).toMatch(/1\. \[high\] Send the Q4 numbers to Anna/)
})

test('the widget shows the count and the first tasks at a glance', async ($, on) => {
  world(on, { store: { tasks: [task({})] } })
  await start($)

  const ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, placement: 'widget' },
    surface: 'desktop',
  })

  expect(await ui.find({ type: 'Text', text: /Teams tasks · 1 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})
