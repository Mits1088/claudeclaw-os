import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

it.each(['true', 'false'])('captures protected diagnostic bytes with outbound guard=%s', enabled => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-output-'));
  const secret = 'synthetic file-only diagnostic credential';
  try {
    fs.writeFileSync(path.join(tmp, '.env'), `PROTECTED_ENV_VARS=FIXTURE_SECRET\nFIXTURE_SECRET=${secret}\n`);
    const script = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(script, `
      import { logger } from ${JSON.stringify(pathToFileURL(path.join(here, 'logger.ts')).href)};
      const secret = ${JSON.stringify(secret)};
      const error = new Error(secret, {cause:new Error(secret)});
      error.name = secret;
      const deep = {}; let tail = deep;
      for (let i=0; i<9; i++) { tail.next = {}; tail = tail.next; }
      tail.secret = secret;
      logger.error({originalMsg:secret, stderr:secret, err:error, deep, [secret]:secret}, 'provider failed');
      logger.warn('provider detail %s', Buffer.from(secret).toString('base64'));
      logger.info(encodeURIComponent(secret));
      logger.info({category:'network', code:'ENOTFOUND', attempt:2}, 'ordinary diagnostic');
      const cyclic = {}; cyclic.self = cyclic; logger.info(cyclic, 'cycle');
      logger.info({nested:{toJSON() { return {secret}; }}}, 'custom serializer');
      const broken = { get detail() { throw new Error(secret); } }; logger.error(broken, secret);
      if (process.env.FIXTURE_SECRET) throw new Error('file secret exported');
    `);
    const result = spawnSync(process.execPath, ['--import', tsx, script], {
      cwd: tmp, windowsHide: true, encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: tmp, USERPROFILE: tmp, TEMP: tmp, TMP: tmp,
        NODE_ENV: 'test', LOG_PRETTY: 'false', LOG_LEVEL: 'info', EXFILTRATION_GUARD_ENABLED: enabled },
    });
    expect(result.status, result.stderr).toBe(0);
    const bytes = result.stdout + result.stderr;
    for (const canary of [secret, Buffer.from(secret).toString('base64'), encodeURIComponent(secret)]) {
      expect(bytes).not.toContain(canary);
    }
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0].originalMsg).toBe('[REDACTED]');
    expect(rows[0].stderr).toBe('[REDACTED]');
    expect(bytes).toContain('[Truncated]');
    expect(bytes).toContain('[Circular]');
    expect(bytes).toContain('[log withheld: redaction error]');
    expect(rows.find(row => row.code === 'ENOTFOUND')).toMatchObject({ category:'network', attempt:2 });
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});
