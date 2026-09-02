# Add Migration

Creates a new versioned migration for ClaudeClaw.

## Steps

### 1. Read current state

Read `migrations/version.json`. Find the highest version key using semver order.
This is the migration registry version, not the application release version.

Do not use the `version` field from `package.json` as the migration base. The migration
registry and application release are separate counters. If the registry has no version
keys, ask the user which initial migration version to create.

### 2. Compute version options

Given the current highest version (e.g. `v1.0.1`), compute:

| Option  | Result   | Behaviour                                      |
|---------|----------|------------------------------------------------|
| current | v1.0.1   | Append to the existing version's array (no new key) |
| patch   | v1.0.2   | New version key                                |
| minor   | v1.1.0   | New version key, reset patch to 0              |
| major   | v2.0.0   | New version key, reset minor and patch to 0    |

Compute these options only from the highest key in `migrations/version.json`. Do not
read or update `package.json`; application versioning is part of the maintainer-only
release process.

### 3. Ask the user

**Q1 — Version bump** (`header: "Version bump"`, single-select)
Four options, each showing the computed result value:
- `current (vX.Y.Z)` — append to existing version, no new key
- `patch (vX.Y.Z+1)` — new version key (default, list first)
- `minor (vX.Y+1.0)` — new version key
- `major (vX+1.0.0)` — new version key

**Q2 — Description** (`header: "Description"`)
A short plain-English sentence describing what this migration does.

### 4. Derive and confirm the filename

Convert the description to a slug:
- Lowercase
- Replace spaces and special characters with hyphens
- Strip leading/trailing hyphens
- Collapse consecutive hyphens

Example: "Rename BOT_TOKEN to TELEGRAM_BOT_TOKEN in .env" → `rename-bot-token-to-telegram-bot-token-in-env`

Use `AskUserQuestion` (`header: "Filename"`) to present the slug as the default option
alongside a free-text "Other" option for customisation.

### 5. Create the migration file

Path: `migrations/<version>/<filename>.ts`

Create the directory if it does not exist.

```ts
export const description = '<the description the user provided>';

export async function run(): Promise<void> {
  // TODO: implement migration
}
```

### 6. Update `migrations/version.json`

- **current** chosen: append the filename to the existing version's array.
- **patch / minor / major** chosen: add a new key with `["<filename>"]`.

### 7. Confirm

Print a summary of everything created or modified:

```
Migration created:

  Version : v1.0.2  (migration registry only)
  File    : migrations/v1.0.2/rename-bot-token.ts
  Registry: migrations/version.json updated
```

## Notes

- Never hardcode paths — derive everything from the repo root (`git rev-parse --show-toplevel`).
- Do not update `package.json` or `CHANGELOG.md`. Version bumps and generated changelog
  updates belong to the maintainer-only release process.
- Do not run `npm run migrate` or touch `migrations/.applied.json` — that is the user's responsibility after reviewing the generated file.
