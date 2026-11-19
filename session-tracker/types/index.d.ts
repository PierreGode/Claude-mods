/** A pull request a session opened or was linked to. */
export type TrackedPr = {
  number: number
  url: string
  /** `open`, `merged`, `closed`, or "" when the record does not say. */
  state: string
  /** The PR's head branch, or "" when the record does not say. */
  branch: string
  /** The repository the PR is in, `owner/name`, or "" when the record does not say. */
  repo: string
}

/** One Claude session found on this machine. */
export type TrackedSession = {
  /** The session's id: its transcript's name. */
  id: string
  title: string
  /** The folder the session last worked in. */
  cwd: string
  /** The branch the session last recorded there, "" when it recorded none. */
  branch: string
  lastActiveAt: number
  isArchived: boolean
  /** The main working tree of the repository `cwd` lies in, "" outside git. */
  repo: string
  /** The working tree `cwd` lies in, "" outside git. */
  worktree: string
  /** True when `cwd` no longer exists. */
  isFolderGone: boolean
  prs: TrackedPr[]
}

/** One local branch of a repository. */
export type TrackedBranch = {
  name: string
  /** The branch it tracks (`origin/main`), "" for none. */
  upstream: string
  /** True when the tracked branch no longer exists on the remote. */
  isUpstreamGone: boolean
  /** Commits not yet pushed to the upstream. */
  ahead: number
  /** Commits on the upstream not yet here. */
  behind: number
  /** Commits not in the default branch; -1 when git could not say. */
  aheadOfDefault: number
  lastCommitAt: number
  /** The working tree it is checked out in, "" for none. */
  worktree: string
}

/** One working tree of a repository: the main checkout or a linked worktree. */
export type TrackedWorktree = {
  path: string
  /** The branch checked out, "" when the head is detached. */
  branch: string
  isMain: boolean
  /** True when git lists the worktree and its folder is gone. */
  isMissing: boolean
  /** Tracked files changed or staged; -1 when git could not say. */
  modified: number
  /** Files git does not track; -1 when git could not say. */
  untracked: number
}

export type TrackedRepo = {
  /** The main working tree. */
  root: string
  name: string
  /** The default branch (`main`), "" when it could not be told. */
  defaultBranch: string
  worktrees: TrackedWorktree[]
  branches: TrackedBranch[]
}

/** Everything one scan found. */
export type TrackerSnapshot = {
  /** 0 before the first scan. */
  scannedAt: number
  sessions: TrackedSession[]
  repos: TrackedRepo[]
}

/** Where the scanning stands. */
export type TrackerStatus = {
  phase: 'idle' | 'scanning' | 'error'
  /** Why the last scan failed, in words; "" otherwise. */
  note: string
  /** The clock at the last minute tick, so relative times are drawn again. */
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-tracker': {
      snapshot: Shaped<TrackerSnapshot>
      status: Shaped<TrackerStatus>
      /** True while the pane lists only what needs attention. */
      isFiltered: boolean
      /** True once the person hid the row above the prompt for this session. */
      isRowHidden: boolean
    }
  }
}
