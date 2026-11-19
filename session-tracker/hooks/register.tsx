// Session tracker: a row above the prompt and a pane that list every Claude
// session on this machine by repository, worktree and branch, and flag what
// holds unsaved work or can be cleaned up. It reads; the one thing it writes
// is a draft in the prompt box.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TrackedSession, TrackerSnapshot, TrackerStatus } from '../types'

import {
  MINUTE,
  ago,
  attentionText,
  line,
  overviewOf,
  overviewText,
  prLabel,
  sessionFacts,
  tidyDraft,
  titleOf,
} from './model'
import type { TrackedNode } from './model'
import { scan } from './scan'

const PANE = 'session-tracker'
const TITLE = 'Sessions'
/** Where the last snapshot is kept for the next session; the tag is its shape. */
const STORE_KEY = 'snapshot-1'
const CLAIM_KEY = 'scanClaimAt'
/** A snapshot this new is not read again when a command or the model asks. */
const FRESH_MS = MINUTE
/** With only the row above the prompt showing, the reads come this much slower. */
const ROW_SLOWDOWN = 6
/** A timer's read another session claimed this recently is left to that session. */
const CLAIM_MS = 2 * MINUTE
const MAX_SESSIONS_SHOWN = 4
const MAX_QUIET_BRANCHES = 8

const EMPTY: TrackerSnapshot = { scannedAt: 0, sessions: [], repos: [] }
const IDLE: TrackerStatus = { phase: 'idle', note: '', tick: 0 }

// Bump a tag when the value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshotAtom = atom(
  { plugin: 'session-tracker', key: 'snapshot' } as const,
  EMPTY,
  { shape: 'snapshot-1' },
)
const statusAtom = atom({ plugin: 'session-tracker', key: 'status' } as const, IDLE, {
  shape: 'status-1',
})
const isFiltered = atom(
  { plugin: 'session-tracker', key: 'isFiltered' } as const,
  false,
)
const isRowHidden = atom(
  { plugin: 'session-tracker', key: 'isRowHidden' } as const,
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

const isSnapshot = (value: unknown): value is TrackerSnapshot => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const held = value as Record<string, unknown>

  return (
    typeof held.scannedAt === 'number' &&
    Array.isArray(held.sessions) &&
    Array.isArray(held.repos)
  )
}

/** The mod's options, as `register` last read them. */
let settings = {
  days: 14,
  refreshMs: 5 * MINUTE,
  staleDays: 3,
  extraRepos: '',
  showsRow: true,
}
/** The scan under way, so two askers share one. */
let running: Promise<TrackerSnapshot> | undefined
let selfId = ''

async function showCounts($: Engine, snapshot: TrackerSnapshot): Promise<void> {
  const now = await $.clock.now()
  const { risk } = overviewOf(snapshot, now, settings.staleDays)

  // The status line names only work that could be forgotten, never clean-up.
  $.ui.status(risk === 0 ? undefined : `Sessions: ${risk} at risk`)
}

/** Takes a newer snapshot another session stored, so the scan is not repeated. */
async function adopt($: Engine): Promise<void> {
  const kept = await $.store.get(STORE_KEY)
  const held = await read($, snapshotAtom)

  if (isSnapshot(kept) && kept.scannedAt > held.scannedAt) {
    await update($, snapshotAtom, () => kept)
    await showCounts($, kept)
  }
}

async function rescan($: Engine): Promise<TrackerSnapshot> {
  await update(
    $,
    statusAtom,
    (status): TrackerStatus => ({ ...status, phase: 'scanning', note: '' }),
  )

  try {
    const snapshot = await scan($, settings)

    await update($, snapshotAtom, () => snapshot)
    await $.store.set(STORE_KEY, snapshot)
    await update(
      $,
      statusAtom,
      (status): TrackerStatus => ({
        ...status,
        phase: 'idle',
        note: '',
        tick: snapshot.scannedAt,
      }),
    )
    await showCounts($, snapshot)

    return snapshot
  } catch (error) {
    const why = line(error instanceof Error ? error.message : String(error), 200)

    await update(
      $,
      statusAtom,
      (status): TrackerStatus => ({
        ...status,
        phase: 'error',
        note: `The scan failed: ${why}`,
      }),
    )

    return read($, snapshotAtom)
  }
}

/** The snapshot, read again when it is stale or `isForced`. */
async function refresh($: Engine, isForced: boolean): Promise<TrackerSnapshot> {
  const held = await read($, snapshotAtom)
  const now = await $.clock.now()

  if (!isForced && held.scannedAt > 0 && now - held.scannedAt < FRESH_MS) {
    return held
  }

  running ??= rescan($).finally(() => {
    running = undefined
  })

  return running
}

/**
 * The minute tick. What somebody can see is kept current: an open pane at the
 * pace the options give, the row above the prompt at a slower one. Every
 * session shares the last read, so ten open sessions still read once.
 */
async function tick($: Engine): Promise<void> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  const isPaneUp = pane !== undefined && pane.isPlaced
  const isRowUp = settings.showsRow && !(await read($, isRowHidden))

  if (!isPaneUp && !isRowUp) {
    return
  }

  await adopt($)

  const now = await $.clock.now()
  const held = await read($, snapshotAtom)
  const every = settings.refreshMs * (isPaneUp ? 1 : ROW_SLOWDOWN)
  const isDue = every > 0 && now - held.scannedAt >= every
  const claimedAt = numberOf(await $.store.get(CLAIM_KEY), 0, 0, Number.MAX_SAFE_INTEGER)

  if (
    isDue &&
    now - claimedAt >= CLAIM_MS &&
    (isPaneUp || (await $.session.surfaces()).length > 0)
  ) {
    await $.store.set(CLAIM_KEY, now)
    await refresh($, true)
  } else {
    await update($, statusAtom, (status): TrackerStatus => ({ ...status, tick: now }))
  }
}

/**
 * Opens the pane and reads again when what is held is old. Answers why the
 * pane is not on screen, or "" when it is: not every surface places panes.
 */
async function openPane($: Engine, isForced: boolean): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: TITLE })

  quietly(refresh($, isForced))

  return opened.isPlaced ? '' : opened.reason || 'this surface places no panes'
}

async function openFromRow($: Engine): Promise<void> {
  const why = await openPane($, false)

  if (why !== '') {
    $.ui.toast(
      `The Sessions panel cannot be shown here (${why}). Type /session-tracker list for the overview.`,
      { timeoutMs: 8000 },
    )
  }
}

/** Puts the clean-up steps in the prompt box as a draft: the person sends it. */
async function askToTidy($: Engine): Promise<void> {
  const now = await $.clock.now()
  const draft = tidyDraft(
    overviewOf(await read($, snapshotAtom), now, settings.staleDays),
  )

  if (draft === '') {
    return
  }

  const box = await $.prompt.read()
  const filled = await $.prompt.fill({
    text: box.text.trim() === '' ? draft : `\n\n${draft}`,
    mode: 'append',
  })

  if (!filled.isFilled) {
    $.ui.toast('The prompt box could not take the request right now.')
  }
}

async function listing($: Engine, repo: string): Promise<string> {
  const snapshot = await refresh($, false)
  const now = await $.clock.now()
  const wanted = repo.toLowerCase()
  const shown: TrackerSnapshot =
    wanted === ''
      ? snapshot
      : {
          ...snapshot,
          repos: snapshot.repos.filter(one => one.name.toLowerCase().includes(wanted)),
          sessions: snapshot.sessions.filter(session =>
            snapshot.repos.some(
              one =>
                one.root === session.repo && one.name.toLowerCase().includes(wanted),
            ),
          ),
        }

  return overviewText(shown, overviewOf(shown, now, settings.staleDays), now, selfId)
}

export const register: Register = (on, options) => {
  settings = {
    days: numberOf(options.days, 14, 1, 90),
    refreshMs: numberOf(options.refreshMinutes, 5, 0, 1440) * MINUTE,
    staleDays: numberOf(options.staleDays, 3, 1, 365),
    extraRepos: typeof options.extraRepos === 'string' ? options.extraRepos : '',
    showsRow: options.showRow !== false,
  }

  on('session.start', async ($, e, next) => {
    selfId = await $.session.id()

    await $.command.register({
      name: 'session-tracker',
      description:
        'Your Claude sessions with their repositories, worktrees and branches: opens the panel; "list" prints it, "refresh" reads it again, "row" shows or hides the row above the prompt',
      argumentHint: '[list|refresh|row]',
    })
    await $.tool.register({
      name: 'overview',
      description:
        "Lists the person's Claude sessions on this machine with the repository, worktree and branch each works in, every local branch and worktree of those repositories, and which of them hold unpushed or uncommitted work or can be cleaned up. Read-only. Use it when asked what sessions, branches or worktrees exist, which are stale, or what is safe to delete.",
      inputSchema: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description:
              "Only the repository whose folder name contains this; leave out for all.",
          },
        },
      },
    })

    // A scan left running by a copy a reload replaced reports to nobody.
    await update(
      $,
      statusAtom,
      (status): TrackerStatus =>
        status.phase === 'scanning' ? { ...status, phase: 'idle' } : status,
    )
    await adopt($)

    $.clock.every(MINUTE, () => {
      quietly(tick($))
    })

    return next(e)
  })

  on('command.run', { command: 'session-tracker' }, async ($, e) => {
    const asked = (e.args ?? '').trim().toLowerCase()

    if (asked === 'list') {
      return { text: await listing($, '') }
    }

    if (asked === 'row') {
      const isHidden = await update($, isRowHidden, hidden => !hidden)

      return {
        text: isHidden
          ? 'The Sessions row above the prompt is hidden. /session-tracker row brings it back.'
          : 'The Sessions row above the prompt is shown.',
        isTextDisplayOnly: true,
      }
    }

    // The pane shows what is known at once and the scan as it lands.
    const why = await openPane($, asked === 'refresh')

    if (why !== '') {
      // No pane on this surface: the overview is printed instead of promised.
      return {
        text: `The Sessions panel cannot be shown here (${why}), so here is the overview.\n\n${await listing($, '')}`,
      }
    }

    return {
      text:
        asked === 'refresh'
          ? 'Reading your sessions, branches and worktrees again.'
          : 'Sessions panel opened.',
      isTextDisplayOnly: true,
    }
  })

  on('tool.run', { tool: 'mcp__session-tracker__overview' }, async ($, e) => ({
    result: await listing($, line(e.repo, 100)),
  })).catch(() => ({ result: 'The session tracker could not read its overview.' }))

  // One row above the prompt, so the tracker is on screen without being asked.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!settings.showsRow || e.props.hasSurvey || (await read($, isRowHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const snapshot = await read($, snapshotAtom)
    const status = await read($, statusAtom)
    const now = await $.clock.now()
    const overview = overviewOf(snapshot, now, settings.staleDays)
    const facts =
      snapshot.scannedAt === 0
        ? [status.phase === 'scanning' ? 'reading...' : 'not read yet']
        : [
            `${overview.sessions} in ${overview.repos.length} ${overview.repos.length === 1 ? 'repo' : 'repos'}`,
            attentionText(overview),
            status.phase === 'scanning' ? 'reading...' : `read ${ago(now, snapshot.scannedAt)}`,
          ].filter(fact => fact !== '')

    return (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text>
          <Text weight="semibold">Sessions</Text> <Text dimColor>{facts.join(' · ')}</Text>
        </Text>
        <Button key="row-open" label="Open" onPress={() => quietly(openFromRow($))} />
        <Button
          key="row-refresh"
          label="Refresh"
          onPress={() => quietly(refresh($, true))}
        />
        <Button
          key="row-hide"
          label="Hide"
          plain
          dimColor
          onPress={() => quietly(update($, isRowHidden, () => true))}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const snapshot = await read($, snapshotAtom)
    const status = await read($, statusAtom)
    const onlyFlagged = await read($, isFiltered)
    const now = await $.clock.now()
    const overview = overviewOf(snapshot, now, settings.staleDays)
    const attention = attentionText(overview)
    const counts = `${overview.sessions} ${overview.sessions === 1 ? 'session' : 'sessions'} · ${overview.repos.length} ${overview.repos.length === 1 ? 'repo' : 'repos'}`

    // The small form of a minimized pane: what reads at a glance.
    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text weight="semibold">{counts}</Text>
          <Text dimColor>{attention === '' ? 'Nothing needs attention.' : attention}</Text>
        </Box>
      )
    }

    const scanned =
      status.phase === 'scanning'
        ? 'reading...'
        : snapshot.scannedAt === 0
          ? 'not read yet'
          : `read ${ago(now, snapshot.scannedAt)}`

    const sessionRow = (session: TrackedSession, node: TrackedNode | undefined) => (
      <Box gap={1} paddingLeft={2}>
        <Text>
          {titleOf(session)}{' '}
          <Text dimColor>{sessionFacts(session, node, now, selfId, false).join(' · ')}</Text>
        </Text>
        {session.prs.map(pr =>
          pr.url === '' ? (
            <Text dimColor>{prLabel(pr, true)}</Text>
          ) : (
            <Link href={pr.url} label={prLabel(pr, true)} />
          ),
        )}
      </Box>
    )

    const sessionRows = (sessions: readonly TrackedSession[], node: TrackedNode | undefined) => [
      ...sessions.slice(0, MAX_SESSIONS_SHOWN).map(session => sessionRow(session, node)),
      ...(sessions.length > MAX_SESSIONS_SHOWN
        ? [
            <Box paddingLeft={2}>
              <Text dimColor>and {sessions.length - MAX_SESSIONS_SHOWN} older</Text>
            </Box>,
          ]
        : []),
    ]

    const nodeRows = (node: TrackedNode) => (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text weight={node.kind === 'worktree' ? 'semibold' : 'regular'}>
            {node.name === '' ? '(detached head)' : node.name}
          </Text>{' '}
          <Text dimColor>{node.facts.join(' · ')}</Text>
        </Text>
        {node.flags.map(flag => (
          <Box paddingLeft={2}>
            <Text color={flag.kind === 'risk' ? 'warning' : 'suggestion'}>
              {flag.kind === 'risk' ? '! ' : '~ '}
              {flag.text}
            </Text>
          </Box>
        ))}
        {sessionRows(node.sessions, node)}
      </Box>
    )

    const repos = overview.repos
      .map(view => {
        const loud = view.nodes.filter(
          node => node.kind === 'worktree' || node.flags.length > 0 || node.sessions.length > 0,
        )
        const quiet = view.nodes.filter(node => !loud.includes(node))
        const nodes = onlyFlagged
          ? view.nodes.filter(node => node.flags.length > 0)
          : [...loud, ...quiet.slice(0, MAX_QUIET_BRANCHES)]

        return { view, nodes, hidden: onlyFlagged ? 0 : quiet.length - MAX_QUIET_BRANCHES }
      })
      .filter(shown => !onlyFlagged || shown.nodes.length > 0)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="semibold">
            {counts} <Text dimColor>· {scanned}</Text>
          </Text>
          <Text dimColor>{attention === '' ? 'Nothing needs attention.' : attention}</Text>
          {status.note !== '' && <Text color="error">{status.note}</Text>}
        </Box>
        <Box gap={1}>
          <Button
            key="refresh"
            label={status.phase === 'scanning' ? 'Reading...' : 'Refresh'}
            variant="primary"
            onPress={() => quietly(refresh($, true))}
          />
          {(overview.risk > 0 || overview.tidy > 0 || onlyFlagged) && (
            <Button
              key="filter"
              label={onlyFlagged ? 'Show all' : 'Only what needs attention'}
              onPress={() => quietly(update($, isFiltered, shown => !shown))}
            />
          )}
          {tidyDraft(overview) !== '' && (
            <Button
              key="tidy"
              label="Ask Claude to tidy"
              onPress={() => quietly(askToTidy($))}
            />
          )}
        </Box>
        {snapshot.scannedAt === 0 && status.phase !== 'scanning' && (
          <Text dimColor>Press Refresh to read your sessions and repositories.</Text>
        )}
        {repos.map(({ view, nodes, hidden }) => (
          <Box flexDirection="column">
            <Text>
              <Text weight="bold">{view.repo.name}</Text>{' '}
              <Text dimColor>{view.repo.root}</Text>
            </Text>
            {nodes.map(nodeRows)}
            {hidden > 0 && (
              <Box paddingLeft={2}>
                <Text dimColor>and {hidden} more branches</Text>
              </Box>
            )}
            {!onlyFlagged && view.strays.length > 0 && (
              <Box flexDirection="column" paddingLeft={2}>
                <Text dimColor>folder no longer a worktree here</Text>
                {sessionRows(view.strays, undefined)}
              </Box>
            )}
          </Box>
        ))}
        {!onlyFlagged && overview.loose.length > 0 && (
          <Box flexDirection="column">
            <Text weight="bold">Outside a git repository</Text>
            {overview.loose.slice(0, 12).map(session => (
              <Box paddingLeft={2}>
                <Text>
                  {titleOf(session)}{' '}
                  <Text dimColor>
                    {[session.cwd, ...sessionFacts(session, undefined, now, selfId, false)].join(
                      ' · ',
                    )}
                  </Text>
                </Text>
              </Box>
            ))}
            {overview.loose.length > 12 && (
              <Box paddingLeft={2}>
                <Text dimColor>and {overview.loose.length - 12} more</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
