# Claude-mods

Mods for Claude Code: small plugins that change what Claude's own interface does. Each mod lives in its own folder.

| Mod | What it does |
| --- | --- |
| [teams-tasks](teams-tasks/) | Reads your recent Microsoft Teams conversations, works out what you need to do, and keeps those tasks in a panel beside the chat. |
| [session-tracker](session-tracker/) | Shows every Claude session on your machine with the repository, worktree and branch it works in, and flags branches and worktrees that hold forgotten work or can be cleaned up. |

## Install a mod

Use the mod's name from the table. At the prompt of a terminal session:

```
/plugin install session-tracker --marketplace PierreGode/Claude-mods
```

Answer `y` to add the marketplace, then pick a scope. The user scope loads the mod in every session, the desktop app's included.

From a shell:

```
claude plugin install session-tracker --marketplace PierreGode/Claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `PierreGode/Claude-mods`, then Add plugin.

## Add a mod

1. Give the mod a folder of its own at the top of this repository, named as the `name` in its `.claude-plugin/plugin.json`.
2. Add one entry for it to [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json), with `"source": "./<folder>"`.
3. Add a row to the table above.
4. Check it: `claude plugin validate <folder>` and `claude plugin test <folder>`.
