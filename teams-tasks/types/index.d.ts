/** One thing the person needs to do, found in a Teams conversation. */
export type TeamsTask = {
  /** The mod's own id for the task. */
  id: string
  /** The scanner's stable name for the source message; a message is added once. */
  key: string
  title: string
  detail: string
  /** Who asked; "me" for the person's own promise. */
  from: string
  /** The chat, channel or meeting it came from. */
  chat: string
  /** YYYY-MM-DD, or "" when no date was given. */
  due: string
  priority: 'high' | 'normal' | 'low'
  /** An https link to the message, or "". */
  link: string
  /** The source message's time, ISO 8601, or "". */
  messageAt: string
  status: 'open' | 'done' | 'dismissed'
  /** Who closed it: the person, or a later scan that saw it handled in Teams. */
  closedBy: '' | 'me' | 'scan'
  createdAt: number
  /** 0 while open. */
  closedAt: number
}

/** Where the scanning stands. */
export type TeamsScan = {
  status: 'idle' | 'scanning' | 'error' | 'no-source'
  /** The last result or failure, in words. */
  note: string
  /** When Teams was last read through, 0 for never. */
  lastScanAt: number
  /** The clock at the last minute tick, so relative times are drawn again. */
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'teams-tasks': {
      tasks: Shaped<TeamsTask[]>
      scan: Shaped<TeamsScan>
      isDoneShown: boolean
    }
  }
}
