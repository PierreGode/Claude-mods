# teams-tasks

A Claude Code mod that reads your recent Microsoft Teams conversations, works out what you personally need to do, and keeps those tasks in a panel beside the chat.

It picks up requests made to you, questions you have not answered, things you promised, and deadlines or follow-ups given to you in group chats and channels. Each task shows who asked, where, and when it is due. When a later scan sees in Teams that you handled a task, the mod closes it.

## What you need

A connector in Claude that can read Teams. The mod looks for one by itself:

- the **Microsoft 365** connector (its `chat_message_search` tool), or
- any MCP server whose tools read Teams chats, channels or messages.

It never uses a tool whose name says it sends, posts, edits or deletes. With no such connector the panel says so and nothing is scanned.

## Install

```
/plugin install teams-tasks --marketplace PierreGode/Claude-mods
```

## Use

| You do | What happens |
| --- | --- |
| `/teams-tasks` | Opens the panel. |
| `/teams-tasks scan` | Reads Teams now. |
| `/teams-tasks list` | Prints the open tasks in the chat, so you can ask Claude about them. |

In the panel each task has **Done**, **Work on it** (puts the task in the prompt box as a draft for you to send to Claude) and **Dismiss** (never show it again). **Scan now** reads Teams, and **Show done** lists finished tasks with a **Reopen** each. The status line shows how many tasks are open, and a toast tells you when a scan found new ones.

Scans also run by themselves, every hour by default, while a session is on screen. Every session shares one task list and one schedule, so ten open sessions still scan once an hour.

## Options

Set them in `/config`, or with `claude plugin configure teams-tasks`.

| Option | Default | What it does |
| --- | --- | --- |
| `scanEveryMinutes` | `60` | How often Teams is checked. `0` scans only when you ask. |
| `lookbackDays` | `3` | How far back the first scan reads. Later scans read from the last one on, 14 days at most. |
| `model` | `sonnet` | The model that reads the conversations: `sonnet`, `haiku`, `opus`, or `inherit` for the session's own. |
| `myName` | | Your name as Teams shows it. Helps in group chats. |
| `tools` | | Exact names of the read-only Teams tools to use (`mcp__server__tool`, comma separated) when the mod does not find them by itself. |
| `openOnNewTasks` | `true` | Opens the panel when a scan finds something new. |

## How it works

A scan starts a background subagent that has the Teams read tools and nothing else: no shell, no files, no way to send a message. The mod allows that subagent's calls to those tools without a prompt, because a background agent has nobody to ask; a deny rule of yours still wins. The subagent answers with a list of tasks as JSON, and the mod merges it into the list it keeps.

What a Teams message says is treated as data. A message that tries to instruct the scanner can at worst put a wrong task on your list, where you can dismiss it. **Work on it** only fills the prompt box: nothing is sent to Claude until you send it.

## What to know

- A scan is a model run on your account, so it uses tokens. Raise `scanEveryMinutes`, pick a smaller `model`, or set `0` to scan only on request.
- Your messages are read by Claude through your own connector, in your own session. The mod sends nothing anywhere else. The task list is kept in the mod's own store file in your Claude Code configuration directory.
- Tasks are the model's reading of your conversations. It can miss one or misread one.

## Develop

```
claude plugin validate teams-tasks
claude plugin test teams-tasks
```

`hooks/tasks.ts` holds the logic with no engine in it (which tools read Teams, the scanner's instructions, reading its answer, merging). `hooks/register.tsx` holds the hooks: the scan, the permission grant, the command and the panel. `types/index.d.ts` declares the state the panel draws from.
