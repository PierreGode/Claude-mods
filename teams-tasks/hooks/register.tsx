// Teams tasks: a background subagent reads the person's recent Teams
// conversations with the session's read-only Teams tools, answers what they
// need to do as JSON, and the mod keeps those tasks in a pane.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TeamsScan, TeamsTask } from '../types'

import {
  MINUTE,
  SCANNER_PROMPT,
  ago,
  doneTasks,
  draftOf,
  isTask,
  line,
  listText,
  mergeScan,
  openTasks,
  parseAnswer,
  pickTeamsTools,
  prune,
  scanRequest,
  sourceOf,
  windowStart,
} from './tasks'

const PANE = 'teams-tasks'
const TITLE = 'Teams tasks'
const SCANNER = 'teams-tasks:scanner'
/** A scan that has not answered by then is given up. */
const SCAN_TIMEOUT_MS = 10 * MINUTE
const NO_SOURCE =
  'No tool that reads Teams is connected. Connect Microsoft 365, or another Teams connector, in Claude, then run /teams-tasks scan.'

const IDLE: TeamsScan = { status: 'idle', note: '', lastScanAt: 0, tick: 0 }

// Bump a tag when the value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const tasksAtom = atom({ plugin: 'teams-tasks', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})
const scanAtom = atom({ plugin: 'teams-tasks', key: 'scan' } as const, IDLE, {
  shape: 'scan-1',
})
const isDoneShown = atom(
  { plugin: 'teams-tasks', key: 'isDoneShown' } as const,
  false,
)

type Engine = EngineInterface

const numberOf = (value: unknown, initial: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : initial

const quietly = (work: Promise<unknown>): void => {
  work.catch(() => {})
}

const reasonOf = (error: unknown): string =>
  line(error instanceof Error ? error.message : String(error), 200)

/** The mod's options, as `register` last read them. */
let settings = {
  everyMs: 60 * MINUTE,
  lookbackDays: 3,
  model: 'sonnet',
  myName: '',
  namedTools: '',
  opensOnNew: true,
}

// This copy's own scan. A reload starts a fresh copy without it.
let pending: { startedAt: number; agentId?: string } | undefined
/** The Teams tools the running scan may call with nobody asked. */
let allowed = new Set<string>()
const scanners = new Set<string>()

// The store is the list every session shares; the state is this session's
// copy of it, which the pane draws from.
async function stored($: Engine): Promise<TeamsTask[]> {
  const raw = await $.store.get('tasks')

  return Array.isArray(raw) ? raw.filter(isTask) : []
}

async function storedTime($: Engine, key: string): Promise<number> {
  return numberOf(await $.store.get(key), 0, 0, Number.MAX_SAFE_INTEGER)
}

async function show($: Engine, tasks: TeamsTask[]): Promise<void> {
  if (JSON.stringify(await read($, tasksAtom)) !== JSON.stringify(tasks)) {
    await update($, tasksAtom, () => tasks)
  }

  const open = openTasks(tasks).length

  $.ui.status(
    open === 0 ? undefined : `Teams: ${open} ${open === 1 ? 'task' : 'tasks'}`,
  )
}

async function change(
  $: Engine,
  edit: (tasks: TeamsTask[], now: number) => TeamsTask[],
): Promise<void> {
  const now = await $.clock.now()
  const tasks = prune(edit(await stored($), now), now)

  await $.store.set('tasks', tasks)
  await show($, tasks)
}

/** Takes in what another session wrote, and moves the pane's clock on. */
async function sync($: Engine): Promise<void> {
  const now = await $.clock.now()
  const lastScanAt = await storedTime($, 'lastScanAt')

  await show($, await stored($))
  await update($, scanAtom, (scan): TeamsScan => ({
    ...scan,
    lastScanAt: Math.max(scan.lastScanAt, lastScanAt),
    tick: now,
  }))
}

async function settle(
  $: Engine,
  status: TeamsScan['status'],
  note: string,
  lastScanAt?: number,
): Promise<void> {
  pending = undefined
  allowed = new Set()
  await update($, scanAtom, (scan): TeamsScan => ({
    ...scan,
    status,
    note,
    lastScanAt: lastScanAt ?? scan.lastScanAt,
  }))
}

/**
 * Starts a scan and says what happened in a line. One the person asked for
 * always runs; one a timer asks for waits its turn across every session.
 */
async function startScan($: Engine, isAsked: boolean): Promise<string> {
  const now = await $.clock.now()

  if (pending !== undefined && now - pending.startedAt < SCAN_TIMEOUT_MS) {
    return 'A Teams scan is already running.'
  }

  if (!isAsked) {
    const lastTryAt = await storedTime($, 'lastTryAt')

    if (now - lastTryAt < Math.max(settings.everyMs, SCAN_TIMEOUT_MS)) {
      return ''
    }
  }

  const tools = pickTeamsTools(await $.tool.list(), settings.namedTools)

  if (tools.length === 0) {
    await settle($, 'no-source', NO_SOURCE)

    return NO_SOURCE
  }

  const started: { startedAt: number; agentId?: string } = { startedAt: now }

  pending = started
  allowed = new Set(tools)
  await $.store.set('lastTryAt', now)
  await update($, scanAtom, (scan): TeamsScan => ({
    ...scan,
    status: 'scanning',
    note: '',
  }))

  try {
    await $.agent.register({
      name: 'scanner',
      description: 'Reads recent Teams conversations for the Teams tasks mod.',
      prompt: SCANNER_PROMPT,
      // Nothing but the read-only Teams tools: what a message says can then
      // do no more than put a wrong task on the list.
      tools: [...tools, 'ToolSearch'],
      model: settings.model,
      background: true,
      omitClaudeMd: true,
      maxTurns: 30,
    })

    const spawned = await $.agent.spawn({
      subagentType: SCANNER,
      description: 'Teams task scan',
      prompt: scanRequest({
        now,
        since: windowStart(
          now,
          await storedTime($, 'lastScanAt'),
          settings.lookbackDays,
        ),
        myName: settings.myName,
        tools,
        known: await stored($),
      }),
    })

    if (spawned.deny !== undefined) {
      const note = `The scan could not start: ${line(spawned.deny, 200)}`

      await settle($, 'error', note)

      return note
    }

    if (spawned.agentId !== undefined) {
      started.agentId = spawned.agentId
      scanners.add(spawned.agentId)
    }
  } catch (error) {
    const note = `The scan could not start: ${reasonOf(error)}`

    await settle($, 'error', note)

    return note
  }

  $.clock.after(SCAN_TIMEOUT_MS, () => {
    if (pending === started) {
      quietly(settle($, 'error', 'The scan took too long and was given up.'))
    }
  })

  return 'Reading your Teams conversations. New tasks appear in the Teams tasks panel.'
}

async function finishScan(
  $: Engine,
  ended: { answer: string; reason: string },
): Promise<void> {
  if (ended.reason !== 'answer') {
    return settle($, 'error', `The scan stopped before it finished (${ended.reason}).`)
  }

  const incoming = parseAnswer(ended.answer)

  if (incoming === undefined) {
    return settle($, 'error', 'The scan gave no answer the mod could read.')
  }

  if (
    incoming.error !== '' &&
    incoming.tasks.length === 0 &&
    incoming.done.length === 0
  ) {
    return settle($, 'error', `Teams could not be read: ${incoming.error}`)
  }

  const now = await $.clock.now()
  let added: TeamsTask[] = []
  let closed = 0

  await change($, tasks => {
    const merged = mergeScan(tasks, incoming, now)

    added = merged.added
    closed = merged.closed

    return merged.tasks
  })
  await $.store.set('lastScanAt', now)

  const found =
    added.length === 0
      ? 'Nothing new'
      : `${added.length} new ${added.length === 1 ? 'task' : 'tasks'}`
  const handled = closed === 0 ? '' : `, ${closed} seen handled in Teams`

  await settle($, 'idle', `${found}${handled}.`, now)

  const first = added[0]

  if (first === undefined) {
    return
  }

  $.ui.toast(
    added.length === 1
      ? `New task from Teams: ${first.title}`
      : `${added.length} new tasks from Teams`,
  )

  if (settings.opensOnNew) {
    await $.ui.open({ id: PANE, title: TITLE })
  }
}

async function isScanner($: Engine, agentId: string): Promise<boolean> {
  if (scanners.has(agentId)) {
    return true
  }

  const agent = (await $.agent.list()).find(one => one.id === agentId)

  if (agent?.type !== SCANNER) {
    return false
  }

  scanners.add(agentId)

  return true
}

/** A timer's scan, only where somebody has the session on screen. */
async function autoScan($: Engine): Promise<void> {
  if (settings.everyMs > 0 && (await $.session.surfaces()).length > 0) {
    await startScan($, false)
  }
}

function close(
  $: Engine,
  id: string,
  status: 'done' | 'dismissed',
): Promise<void> {
  return change($, (tasks, now) =>
    tasks.map(task =>
      task.id === id
        ? { ...task, status, closedBy: 'me' as const, closedAt: now }
        : task,
    ),
  )
}

function reopen($: Engine, id: string): Promise<void> {
  return change($, tasks =>
    tasks.map(task =>
      task.id === id
        ? { ...task, status: 'open' as const, closedBy: '' as const, closedAt: 0 }
        : task,
    ),
  )
}

/** Puts the task in the prompt box as a draft: the person reads and sends it. */
async function workOn($: Engine, task: TeamsTask): Promise<void> {
  const box = await $.prompt.read()
  const draft = draftOf(task)
  const filled = await $.prompt.fill({
    text: box.text.trim() === '' ? draft : `\n\n${draft}`,
    mode: 'append',
  })

  if (!filled.isFilled) {
    $.ui.toast('The prompt box could not take the task right now.')
  }
}

export const register: Register = (on, options) => {
  settings = {
    everyMs: numberOf(options.scanEveryMinutes, 60, 0, 1440) * MINUTE,
    lookbackDays: numberOf(options.lookbackDays, 3, 1, 14),
    model: line(options.model, 100) || 'sonnet',
    myName: line(options.myName, 80),
    namedTools: typeof options.tools === 'string' ? options.tools : '',
    opensOnNew: options.openOnNewTasks !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'teams-tasks',
      description:
        'Tasks found in your Teams chats: opens the panel; "scan" checks Teams now, "list" prints them',
      argumentHint: '[scan|list]',
    })

    // A scan left running by a copy a reload replaced reports to nobody.
    await update($, scanAtom, (scan): TeamsScan =>
      scan.status === 'scanning' ? { ...scan, status: 'idle', note: '' } : scan,
    )
    await sync($)

    $.clock.every(MINUTE, () => {
      quietly(sync($).then(() => autoScan($)))
    })
    $.clock.after(20_000, () => {
      quietly(autoScan($))
    })

    return next(e)
  })

  // The scanner is the mod's own: the model is never offered it.
  on('agent.offer', { agent: SCANNER }, () => ({ isOffered: false })).catch(
    () => ({ isOffered: false }),
  )

  // A background scan has nobody to ask, so the mod answers for it: the
  // scanner's calls to the Teams tools it was given run, unless a rule denies.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)

    if (
      verdict.decision === 'deny' ||
      e.agentId === undefined ||
      !allowed.has(e.tool) ||
      !(await isScanner($, e.agentId))
    ) {
      return verdict
    }

    return {
      decision: 'allow',
      reason: 'The Teams tasks scan reads Teams with this tool.',
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const isMine =
      pending !== undefined &&
      e.agentId !== undefined &&
      (pending.agentId === undefined || pending.agentId === e.agentId) &&
      (await isScanner($, e.agentId))

    if (isMine) {
      try {
        await finishScan($, e)
      } catch (error) {
        await settle($, 'error', `The scan's answer could not be kept: ${reasonOf(error)}`)
      }
    }

    return next(e)
  })

  on('command.run', { command: 'teams-tasks' }, async ($, e) => {
    const asked = (e.args ?? '').trim().toLowerCase()

    if (asked === 'list') {
      await sync($)

      return { text: listText(await stored($)) }
    }

    await $.ui.open({ id: PANE, title: TITLE })

    if (asked === 'scan') {
      return { text: await startScan($, true), isTextDisplayOnly: true }
    }

    await sync($)

    const open = openTasks(await stored($)).length

    return {
      text: `Teams tasks panel opened: ${open} open.`,
      isTextDisplayOnly: true,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const tasks = await read($, tasksAtom)
    const scan = await read($, scanAtom)
    const showsDone = await read($, isDoneShown)
    const now = await $.clock.now()
    const open = openTasks(tasks)
    const done = doneTasks(tasks)
    const markOf = (task: TeamsTask): string => (task.priority === 'high' ? '! ' : '')

    // The small form of a minimized pane: what reads at a glance.
    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text weight="semibold">
            Teams tasks · {open.length} open
          </Text>
          {open.length === 0 && <Text dimColor>Nothing to do.</Text>}
          {open.slice(0, 3).map(task => (
            <Text wrap="truncate-end">
              {markOf(task)}
              {task.title}
            </Text>
          ))}
        </Box>
      )
    }

    const scanned =
      scan.status === 'scanning'
        ? 'reading Teams...'
        : scan.lastScanAt === 0
          ? 'not scanned yet'
          : `scanned ${ago(now, scan.lastScanAt)}`

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="semibold">
            {open.length} open <Text dimColor>· {scanned}</Text>
          </Text>
          {scan.note !== '' && <Text dimColor>{scan.note}</Text>}
        </Box>
        <Box gap={1}>
          <Button
            key="scan"
            label={scan.status === 'scanning' ? 'Scanning...' : 'Scan now'}
            variant="primary"
            onPress={() => quietly(startScan($, true))}
          />
          {done.length > 0 && (
            <Button
              key="toggle-done"
              label={showsDone ? 'Hide done' : `Show done (${done.length})`}
              onPress={() => quietly(update($, isDoneShown, shown => !shown))}
            />
          )}
        </Box>
        {open.length === 0 && scan.status !== 'scanning' && (
          <Text dimColor>Nothing to do from Teams right now.</Text>
        )}
        {open.slice(0, 40).map(task => (
          <Box flexDirection="column">
            <Text weight="semibold">
              {markOf(task)}
              {task.title}
            </Text>
            {sourceOf(task) !== '' && <Text dimColor>{sourceOf(task)}</Text>}
            {task.detail !== '' && <Text>{task.detail}</Text>}
            <Box gap={1}>
              <Button
                key={`done:${task.id}`}
                label="Done"
                onPress={() => quietly(close($, task.id, 'done'))}
              />
              <Button
                key={`work:${task.id}`}
                label="Work on it"
                onPress={() => quietly(workOn($, task))}
              />
              <Button
                key={`drop:${task.id}`}
                label="Dismiss"
                dimColor
                onPress={() => quietly(close($, task.id, 'dismissed'))}
              />
              {task.link !== '' && <Link href={task.link} label="Open in Teams" />}
            </Box>
          </Box>
        ))}
        {open.length > 40 && <Text dimColor>and {open.length - 40} more</Text>}
        {showsDone &&
          done.slice(0, 20).map(task => (
            <Box gap={1}>
              <Text dimColor strikethrough>
                {task.title}
              </Text>
              {task.closedBy === 'scan' && <Text dimColor>(handled in Teams)</Text>}
              <Button
                key={`reopen:${task.id}`}
                label="Reopen"
                plain
                dimColor
                onPress={() => quietly(reopen($, task.id))}
              />
            </Box>
          ))}
      </Box>
    )
  })
}
