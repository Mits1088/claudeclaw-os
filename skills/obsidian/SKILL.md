---
name: obsidian
description: Read and write notes in the shared, git-synced Obsidian vault. Create documentation, log findings, and search existing notes.
allowed-tools: Bash(node dist/obsidian-cli.js *)
---

# Obsidian Vault Skill

## Purpose

Read, write, and search notes in ClaudeClaw's shared Obsidian vault from Claude Code. The vault is a git-synced working copy on the VPS — every write pulls first, then commits and pushes, so it stays in sync with any Obsidian client (laptop, teammate) that also has it cloned.

## Availability

This is a runtime-activated feature. If the CLI reports "Obsidian is not enabled," it means the Obsidian toggle in the dashboard's Settings page is off — ask Philip to enable it there (or, if you have dashboard-settings access, flip `obsidian_config.enabled` via `PATCH /api/dashboard/settings`). There is nothing to install; the vault is provisioned automatically the first time it's enabled.

Your write access is scoped per-agent by the `obsidian:` block in your `agent.yaml` (`folders`/`read_only` for reading, `write_folders` for writing). If a command reports you can't read or write a given folder, that's a scope limit, not a bug — ask for the folder to be added to your `agent.yaml` if you need it.

## Commands

### Read a note

```bash
node dist/obsidian-cli.js read "Projects/idea.md"
```

Prints the note's raw content. Errors if the note doesn't exist or is outside your configured read folders.

### Write (create or overwrite) a note

```bash
node dist/obsidian-cli.js write "Projects/idea.md" "# Idea\n\nSome content."
```

For longer content, pipe it in instead of quoting a huge argument:

```bash
echo "# Idea\n\nSome content." | node dist/obsidian-cli.js write "Projects/idea.md" --stdin
```

**Always show the user what you're about to write before overwriting an existing note** — writes replace the file wholesale. Use `append` instead if you just want to add to what's already there.

### Append to a note

```bash
node dist/obsidian-cli.js append "Projects/idea.md" "- Another thought"
```

Creates the note if it doesn't exist yet.

### Search notes

```bash
node dist/obsidian-cli.js search "quarterly roadmap"
```

Returns `file:line: matching text` for every hit across your configured read folders.

### Daily note

```bash
node dist/obsidian-cli.js daily
```

Gets or creates today's note under `ClaudeClaw/<your-agent-id>/YYYY-MM-DD.md` and prints its path. Combine with `append` to log findings as you work:

```bash
DAILY=$(node dist/obsidian-cli.js daily)
node dist/obsidian-cli.js append "$DAILY" "- Found: ..."
```

### List notes in a folder

```bash
node dist/obsidian-cli.js list "Projects"
```

## Error Handling

- "Obsidian is not enabled" — the feature is off; tell the user where to turn it on (dashboard Settings).
- "cannot read/write outside its configured folders" — a scope limit from `agent.yaml`, not a transient error. Don't retry; report it.
- "saved locally but sync failed" — the note was written and committed, but the push to the shared remote failed (e.g. a network blip). The content isn't lost; mention the sync issue to the user rather than silently ignoring it.
