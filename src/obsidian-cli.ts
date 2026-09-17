#!/usr/bin/env node
/**
 * ClaudeClaw Obsidian Vault CLI.
 *
 * A thin argv front door over the shared actions in `obsidian-actions.ts` —
 * the same functions the in-process/stdio dispatch tools call. Permission
 * checks, vault resolution and git behaviour live THERE, never here, so the
 * two entry points cannot drift apart.
 *
 * Usage:
 *   node dist/obsidian-cli.js read <path>
 *   node dist/obsidian-cli.js write <path> <content>
 *   node dist/obsidian-cli.js write <path> --stdin   (reads content from stdin)
 *   node dist/obsidian-cli.js append <path> <text>
 *   node dist/obsidian-cli.js search <query>
 *   node dist/obsidian-cli.js daily
 *   node dist/obsidian-cli.js list <folder>
 */

import { CliActionError } from './cli-actions.js';
import { renderHelp } from './cli-reference.js';
import { obsidianDescriptor as descriptor } from './cli-descriptors.js';
import {
  actionObsidianAppend,
  actionObsidianDaily,
  actionObsidianList,
  actionObsidianRead,
  actionObsidianSearch,
  actionObsidianWrite,
} from './obsidian-actions.js';

const [, , command, ...rest] = process.argv;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  // Answer --help before touching the DB or agent config, so it works even
  // when the vault is disabled or the agent has no obsidian block.
  if (command === '--help' || command === '-h' || command === undefined) {
    console.log(renderHelp(descriptor));
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case 'read': {
      const relPath = rest[0];
      if (!relPath) die('Usage: obsidian-cli read <path>');
      console.log(await actionObsidianRead(relPath));
      break;
    }

    case 'write': {
      const relPath = rest[0];
      if (!relPath) die('Usage: obsidian-cli write <path> <content> | write <path> --stdin');
      const content = rest[1] === '--stdin' ? await readStdin() : (rest[1] ?? '');
      console.log(await actionObsidianWrite(relPath, content));
      break;
    }

    case 'append': {
      const relPath = rest[0];
      const text = rest.slice(1).join(' ');
      if (!relPath || !text) die('Usage: obsidian-cli append <path> <text>');
      console.log(await actionObsidianAppend(relPath, text));
      break;
    }

    case 'search': {
      const query = rest.join(' ');
      if (!query) die('Usage: obsidian-cli search <query>');
      const results = await actionObsidianSearch(query);
      if (results.length === 0) { console.log('No matches.'); break; }
      for (const r of results) console.log(`${r.file}:${r.line}: ${r.text}`);
      break;
    }

    case 'daily': {
      console.log(await actionObsidianDaily());
      break;
    }

    case 'list': {
      const entries = await actionObsidianList(rest[0] ?? '');
      if (entries.length === 0) { console.log('(empty)'); break; }
      for (const name of entries) console.log(name);
      break;
    }

    default:
      die('Commands: read | write | append | search | daily | list');
  }
}

main().catch((err: unknown) => {
  // A CliActionError is an expected denial or user-facing failure (scope,
  // disabled feature, sync failure) — print it verbatim, not as a crash.
  if (err instanceof CliActionError) die(err.message);
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
