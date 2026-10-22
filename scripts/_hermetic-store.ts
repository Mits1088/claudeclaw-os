/**
 * Guard for non-vitest scripts that open the database (initDatabase, etc.).
 * Import it FIRST (before '../src/db.js'): static ESM imports evaluate in
 * order, so this module sets CLAUDECLAW_STORE_DIR before config.ts reads .env
 * (which may point at the live production store).
 *
 * Default: a throwaway store under tmpdir. To target another store on
 * purpose, set CLAUDECLAW_SCRIPT_STORE_DIR to an existing directory under tmpdir; any path
 * outside tmpdir is refused.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const requested = process.env.CLAUDECLAW_SCRIPT_STORE_DIR;
const dir = requested
  || fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-script-store-'));

const real = fs.realpathSync(dir);
const tmp = fs.realpathSync(os.tmpdir());
if (real !== tmp && !real.startsWith(tmp + path.sep)) {
  throw new Error(`refused: script store outside tmpdir (${real})`);
}
process.env.CLAUDECLAW_STORE_DIR = real;
console.log(`[hermetic] throwaway store: ${real}`);
