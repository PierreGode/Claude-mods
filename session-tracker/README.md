# session-tracker

A Claude Code mod that shows every Claude session on your machine with the repository, worktree and branch it works in, and flags the branches and worktrees that hold forgotten work or can be cleaned up.

When you run many sessions across many repositories, it answers three questions in one panel:

- Which sessions do I have, where is each one working, and what was it about?
- Which branches and worktrees hold work that exists only on this machine?
- Which branches and worktrees are finished and can go?

```
12 sessions · 4 repos · read 2 min ago
1 at risk · 3 to tidy

shop-api   C:/code/shop-api
  feature/checkout   main checkout · 3 changed · 2 to push · shop-api#41 open
    Checkout retry logic   this session · active now        shop-api#41 open
    Flaky payment test     3 h ago · was on fix/payment-test
  fix/login   worktree shop-api-login · clean · merged into main
    ~ branch merged and folder clean: the worktree can be removed
  spike/cache   2 to push · last commit 3 wk ago
    ! 2 commits not pushed, untouched for 21 days
  old/report   merged into main · last commit 4 mo ago
    ~ merged: the branch can be deleted
```

## What it flags

**At risk** is work that could be forgotten: commits never pushed, or changed files never committed, on a branch or worktree nothing has touched for a few days. Work you are in the middle of is not flagged.

**To tidy** is what can be cleaned up: a branch merged into the default branch, a branch with no commits of its own, a worktree whose branch is merged and whose folder is clean, a worktree whose folder is gone, a branch whose remote branch was deleted.

## Install

```
/plugin install session-tracker --marketplace PierreGode/Claude-mods
```

It needs `git` 2.31 or newer on the path. With git 2.41 or newer it can tell that a branch is merged by comparing it with the default branch; with an older git it only knows from a pull request Claude recorded as merged.

## Use

The mod puts one row above the prompt, so it is on screen without being asked:

```
Sessions  12 in 4 repos · 1 at risk · 3 to tidy · read 2 min ago   [ Open ] [ Refresh ] Hide
```

**Open** opens the panel, **Refresh** reads everything again, and **Hide** removes the row for this session.

| You do | What happens |
| --- | --- |
| `/session-tracker` | Opens the panel and reads everything again if what it has is old. |
| `/session-tracker refresh` | Reads everything again now. |
| `/session-tracker list` | Prints the whole overview in the chat. |
| `/session-tracker row` | Shows or hides the row above the prompt. |
| Ask Claude, in your own words | Claude can read the overview itself: "which of my branches are safe to delete?", "what was I doing in shop-api last week?" |

In the panel, **Refresh** reads again, **Only what needs attention** hides everything without a flag, and **Ask Claude to tidy** puts the clean-up steps in the prompt box as a draft for you to read and send. The status line shows a count only when something is at risk.

Where a surface cannot show a panel, `/session-tracker` prints the overview in the chat instead and says why.

While the panel is open it reads again every five minutes. With only the row showing it reads every thirty. Every session shares the last read, so many open sessions still read once. With the row switched off and the panel closed, the mod does nothing.

## Options

Set them in `/config`, or with `claude plugin configure session-tracker`.

| Option | Default | What it does |
| --- | --- | --- |
| `showRow` | `true` | Shows the row above the prompt. |
| `days` | `14` | How far back sessions are listed. A repository is tracked when a session in this window worked in it. |
| `refreshMinutes` | `5` | How often an open panel reads again; the row alone reads six times slower. `0` reads only when you ask. |
| `staleDays` | `3` | How long unpushed or uncommitted work must sit untouched before it is flagged. |
| `extraRepos` | | Folders of repositories to track even when no recent session worked there, separated by semicolons. |

## What it reads

- **Session transcripts** in `~/.claude/projects`: only the end of each file, for the folder and branch the session last worked in, its title, and links to its pull requests. It works for terminal sessions and desktop app sessions alike.
- **The desktop app's session records**, where the app is installed: for the title you see in the app, the archived mark, and the state of each pull request.
- **git**, in every repository a listed session worked in: `rev-parse`, `worktree list`, `for-each-ref` and `status`.

## What it does not do

- It changes nothing in your repositories. Every git command is a read, and each runs with `GIT_OPTIONAL_LOCKS=0` so it never holds a lock a session's own git is waiting for. It does not fetch, so "behind" and "merged" are as of your last fetch.
- It deletes nothing. **Ask Claude to tidy** writes a draft; Claude does the work only after you send it, with its usual permission prompts.
- It sends nothing anywhere. Everything stays on your machine; the last overview is kept in the mod's own store file in your Claude Code configuration directory, so a new session starts with it.

## Limits

- A squash merge leaves commits the default branch lacks, so git alone cannot call the branch merged. The mod knows it is merged when Claude recorded the pull request as merged; otherwise it says the remote branch is gone and asks you to check.
- A pull request is matched to a branch only when it is in the same repository, by the repository's folder name.
- The transcript and app record formats are Claude's own and can change. When a file cannot be read the session is listed with less detail, or left out.
- A session is listed where it last worked. When several sessions share one checkout and one of them switches branch, the others are shown with the branch they last recorded ("was on ...").

## Develop

```
claude plugin validate session-tracker
claude plugin test session-tracker
```

`hooks/model.ts` holds the logic with no engine in it: reading git's output and Claude's records, and deciding what to flag. `hooks/scan.ts` does one scan through the engine's file and process calls. `hooks/register.tsx` holds the hooks: the command, the tool the model calls, the refresh and the panel. `types/index.d.ts` declares the state the panel draws from.
