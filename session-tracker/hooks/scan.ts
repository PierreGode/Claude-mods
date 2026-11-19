// One scan: the sessions Claude has recorded on this machine, and for every
// repository one of them worked in, its working trees and branches as git
// reports them. It reads only; no git command here changes anything.

import type { EngineInterface } from 'claude-code'

import type {
  TrackedRepo,
  TrackedSession,
  TrackedWorktree,
  TrackerSnapshot,
} from '../types'

import {
  DAY,
  DEFAULT_FORMAT,
  DEFAULT_REFS,
  MINUTE,
  baseName,
  branchFormat,
  countStatus,
  joinSessions,
  parseBranches,
  parseDefault,
  parseWorktrees,
  pathKey,
  readAppRecord,
  readTail,
} from './model'
import type { AppFacts, TailFacts } from './model'

type Engine = EngineInterface

export type ScanSettings = { days: number; extraRepos: string }

/** How much of a transcript's end is read: the facts sit in its last lines. */
const TAIL_BYTES = 96 * 1024
const HEAD_BYTES = 32 * 1024
const MAX_SESSIONS = 150
const MAX_RECORD_BYTES = 4 * 1024 * 1024
const GIT_TIMEOUT_MS = 20_000
const PLACE_TTL_MS = 10 * MINUTE

type FoundFile = { id: string; path: string; size: number; mtimeMs: number }
/** Where a folder lies: its repository's git directory and its working tree. */
type Place = { common: string; worktree: string; isGone: boolean }

// What an earlier scan read, kept while the file stands unchanged.
const tails = new Map<string, { size: number; mtimeMs: number; facts: TailFacts }>()
const records = new Map<
  string,
  { size: number; mtimeMs: number; facts: AppFacts | undefined }
>()
const places = new Map<string, { at: number; place: Place }>()

const NO_TAIL: TailFacts = { cwd: '', branch: '', title: '', lastAt: 0, prs: [] }

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const all: T[][] = []

  for (let index = 0; index < items.length; index += size) {
    all.push(items.slice(index, index + size))
  }

  return all
}

/** Runs a read-only git command in `cwd`; undefined when it fails. */
async function git(
  $: Engine,
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['git', '-C', cwd, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
      // A status read must not take the index lock a session's own git wants.
      env: { GIT_OPTIONAL_LOCKS: '0' },
    })

    return ran.exitCode === 0 ? ran.stdout : undefined
  } catch {
    return undefined
  }
}

async function listed($: Engine, path: string) {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

async function claudeFolders(
  $: Engine,
): Promise<{ projects: string; apps: string[] }> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const config =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === '' ? '' : `${home}/.claude`)
  const roaming = (await $.env.get('APPDATA')) ?? ''
  const xdg = (await $.env.get('XDG_CONFIG_HOME')) ?? ''
  // Where the desktop app keeps its session records, per platform.
  const apps = [
    roaming === '' ? '' : `${roaming}/Claude`,
    home === '' ? '' : `${home}/Library/Application Support/Claude`,
    xdg === '' ? '' : `${xdg}/Claude`,
    home === '' ? '' : `${home}/.config/Claude`,
  ]
    .filter(folder => folder !== '')
    .map(folder => `${folder}/claude-code-sessions`)

  return { projects: config === '' ? '' : `${config}/projects`, apps }
}

/** The transcripts written to since `since`, newest first. */
async function findTranscripts(
  $: Engine,
  projects: string,
  since: number,
): Promise<FoundFile[]> {
  const folders = (await listed($, projects)).filter(entry => entry.kind === 'dir')
  const found: FoundFile[] = []

  for (const batch of chunks(folders, 8)) {
    const lists = await Promise.all(
      batch.map(folder => listed($, `${projects}/${folder.name}`)),
    )

    lists.forEach((entries, index) => {
      for (const entry of entries) {
        if (
          entry.kind === 'file' &&
          entry.name.endsWith('.jsonl') &&
          entry.mtimeMs >= since
        ) {
          found.push({
            id: entry.name.slice(0, -'.jsonl'.length),
            path: `${projects}/${batch[index]?.name}/${entry.name}`,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          })
        }
      }
    })
  }

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSIONS)
}

async function tailOf(
  $: Engine,
  file: FoundFile,
): Promise<TailFacts & { id: string; mtimeMs: number }> {
  const kept = tails.get(file.path)

  if (kept !== undefined && kept.size === file.size && kept.mtimeMs === file.mtimeMs) {
    return { ...kept.facts, id: file.id, mtimeMs: file.mtimeMs }
  }

  let facts = NO_TAIL

  try {
    const offset = Math.max(0, file.size - TAIL_BYTES)

    facts = readTail(
      await $.fs.read(file.path, { offset, length: TAIL_BYTES }),
      offset > 0,
    )

    if (facts.cwd === '' && offset > 0) {
      // The end held only bulk: the start of a transcript names the folder too.
      const head = readTail(
        await $.fs.read(file.path, { offset: 0, length: HEAD_BYTES }),
        false,
      )

      facts = {
        ...facts,
        cwd: head.cwd,
        branch: head.branch,
        title: facts.title || head.title,
        lastAt: facts.lastAt || head.lastAt,
      }
    }
  } catch {
    facts = NO_TAIL
  }

  tails.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, facts })

  return { ...facts, id: file.id, mtimeMs: file.mtimeMs }
}

/** The desktop app's session records: two folders deep, one file a session. */
async function findRecords($: Engine, roots: readonly string[]): Promise<FoundFile[]> {
  const found: FoundFile[] = []

  for (const root of roots) {
    for (const account of await listed($, root)) {
      if (account.kind !== 'dir') {
        continue
      }

      for (const space of await listed($, `${root}/${account.name}`)) {
        if (space.kind !== 'dir') {
          continue
        }

        const folder = `${root}/${account.name}/${space.name}`

        for (const entry of await listed($, folder)) {
          if (
            entry.kind === 'file' &&
            entry.name.startsWith('local_') &&
            entry.name.endsWith('.json') &&
            entry.size <= MAX_RECORD_BYTES
          ) {
            found.push({
              id: entry.name,
              path: `${folder}/${entry.name}`,
              size: entry.size,
              mtimeMs: entry.mtimeMs,
            })
          }
        }
      }
    }
  }

  return found
}

async function recordOf($: Engine, file: FoundFile): Promise<AppFacts | undefined> {
  const kept = records.get(file.path)

  if (kept !== undefined && kept.size === file.size && kept.mtimeMs === file.mtimeMs) {
    return kept.facts
  }

  let facts: AppFacts | undefined

  try {
    facts = readAppRecord(await $.fs.read(file.path))
  } catch {
    facts = undefined
  }

  records.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, facts })

  return facts
}

async function placeOf($: Engine, cwd: string, now: number): Promise<Place> {
  const kept = places.get(pathKey(cwd))

  if (kept !== undefined && now - kept.at < PLACE_TTL_MS) {
    return kept.place
  }

  const out = await git($, cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
  ])
  const [worktree, common] = (out ?? '').split('\n').map(row => row.trim())
  let place: Place

  if (worktree !== undefined && worktree !== '' && common !== undefined && common !== '') {
    place = { common, worktree, isGone: false }
  } else {
    let isGone = false

    try {
      isGone = !(await $.fs.exists(cwd))
    } catch {
      isGone = false
    }

    place = { common: '', worktree: '', isGone }
  }

  places.set(pathKey(cwd), { at: now, place })

  return place
}

async function statusOf($: Engine, tree: TrackedWorktree): Promise<TrackedWorktree> {
  if (tree.isMissing) {
    return tree
  }

  const out = await git($, tree.path, [
    'status',
    '--porcelain',
    '--untracked-files=normal',
  ])

  return out === undefined ? tree : { ...tree, ...countStatus(out) }
}

/** A repository's working trees and branches, read from any of its trees. */
async function repoOf($: Engine, from: string): Promise<TrackedRepo | undefined> {
  const [trees, refs] = await Promise.all([
    git($, from, ['worktree', 'list', '--porcelain']),
    git($, from, ['for-each-ref', `--format=${DEFAULT_FORMAT}`, ...DEFAULT_REFS]),
  ])
  const worktrees = parseWorktrees(trees ?? '')
  const main = worktrees.find(tree => tree.isMain) ?? worktrees[0]

  if (main === undefined) {
    return undefined
  }

  const base = parseDefault(refs ?? '')
  // An older git does not know ahead-behind: the branches are read without it.
  const heads =
    (base.compare === ''
      ? undefined
      : await git($, from, [
          'for-each-ref',
          `--format=${branchFormat(base.compare)}`,
          'refs/heads',
        ])) ??
    (await git($, from, ['for-each-ref', `--format=${branchFormat('')}`, 'refs/heads']))

  return {
    root: main.path,
    name: baseName(main.path),
    defaultBranch: base.branch,
    worktrees: await Promise.all(worktrees.map(tree => statusOf($, tree))),
    branches: parseBranches(heads ?? ''),
  }
}

export async function scan($: Engine, settings: ScanSettings): Promise<TrackerSnapshot> {
  const now = await $.clock.now()
  const since = now - settings.days * DAY
  const folders = await claudeFolders($)

  const tailFacts: (TailFacts & { id: string; mtimeMs: number })[] = []
  const files =
    folders.projects === '' ? [] : await findTranscripts($, folders.projects, since)

  for (const batch of chunks(files, 8)) {
    tailFacts.push(...(await Promise.all(batch.map(file => tailOf($, file)))))
  }

  const appFacts: AppFacts[] = []

  for (const batch of chunks(await findRecords($, folders.apps), 6)) {
    const read = await Promise.all(batch.map(file => recordOf($, file)))

    appFacts.push(...read.filter((facts): facts is AppFacts => facts !== undefined))
  }

  const found = joinSessions(tailFacts, appFacts, since)
  const extra = settings.extraRepos
    .split(/[;\n]/)
    .map(folder => folder.trim())
    .filter(folder => folder !== '')
  const cwds = [
    ...new Map(
      [...found.map(session => session.cwd), ...extra].map(cwd => [pathKey(cwd), cwd]),
    ).values(),
  ]
  const placed = new Map<string, Place>()

  for (const batch of chunks(cwds, 6)) {
    const got = await Promise.all(batch.map(cwd => placeOf($, cwd, now)))

    batch.forEach((cwd, index) => {
      const place = got[index]

      if (place !== undefined) {
        placed.set(pathKey(cwd), place)
      }
    })
  }

  // One read of each repository, from whichever of its working trees was met first.
  const starts = new Map<string, string>()

  for (const place of placed.values()) {
    if (place.common !== '' && !starts.has(pathKey(place.common))) {
      starts.set(pathKey(place.common), place.worktree)
    }
  }

  const repos = new Map<string, TrackedRepo>()

  for (const batch of chunks([...starts], 3)) {
    const got = await Promise.all(batch.map(([, from]) => repoOf($, from)))

    batch.forEach(([common], index) => {
      const repo = got[index]

      if (repo !== undefined) {
        repos.set(common, repo)
      }
    })
  }

  const all = [...repos.values()]
  const sessions: TrackedSession[] = found.map(session => {
    const place = placed.get(pathKey(session.cwd))
    const repo = place === undefined ? undefined : repos.get(pathKey(place.common))

    if (place !== undefined && repo !== undefined) {
      return { ...session, repo: repo.root, worktree: place.worktree, isFolderGone: false }
    }

    // A folder that is gone was a worktree of the repository it lay under.
    const parent =
      place?.isGone === true
        ? all.find(one => pathKey(session.cwd).startsWith(`${pathKey(one.root)}/`))
        : undefined

    return {
      ...session,
      repo: parent?.root ?? '',
      worktree: parent === undefined ? '' : session.cwd,
      isFolderGone: place?.isGone ?? false,
    }
  })

  return { scannedAt: now, sessions, repos: all }
}
