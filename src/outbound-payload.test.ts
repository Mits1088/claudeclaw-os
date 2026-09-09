import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api, InputFile } from 'grammy';

const fixture = vi.hoisted(() => ({ secret: 'alpha\nbeta "quoted" \\ credential' }));
vi.mock('./outbound-policy.js', () => ({
  resolveOutboundPolicy: () => ({ enabled: true, protectedValues: [fixture.secret] }),
  outboundOptionsForSeam: () => ({ enabled: true, protectedValues: [fixture.secret] }),
}));

import { outboundTelegramTransformer, sanitizePresentation } from './outbound-payload.js';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-outbound-payload-')); });
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

it('keeps class instances intact and still rewrites text fields on plain objects', () => {
  const file = new InputFile(path.join(tmpDir, 'report.md'));
  const bytes = Buffer.from('raw');
  const out = sanitizePresentation({ document: file, bytes, caption: fixture.secret, nested: { text: fixture.secret } }, 'telegram.api');
  expect(out.document).toBe(file);
  expect(out.bytes).toBe(bytes);
  expect(out.caption).toBe('[REDACTED]');
  expect(out.nested.text).toBe('[REDACTED]');
});

it('lets the Telegram transformer upload an InputFile as multipart while sanitizing the caption', async () => {
  const filePath = path.join(tmpDir, 'report.md');
  fs.writeFileSync(filePath, 'fixture document bytes');
  const requests: { contentType: string; body: string }[] = [];
  const api = new Api('123:fixture', { fetch: (async (_url: unknown, init: any) => {
    const chunks: Buffer[] = [];
    if (typeof init.body === 'string') chunks.push(Buffer.from(init.body));
    else for await (const chunk of init.body as Readable) chunks.push(Buffer.from(chunk));
    requests.push({ contentType: String(init.headers?.['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 7, type: 'private' }, date: 1,
      document: { file_id: 'fixture', file_unique_id: 'fixture' } } }));
  }) as any });
  api.config.use(outboundTelegramTransformer);

  await api.sendDocument(7, new InputFile(filePath), { caption: fixture.secret });

  expect(requests).toHaveLength(1);
  // Before the fix the transformer rebuilt the InputFile as a plain object and
  // grammY sent a JSON body, which Telegram rejects as an invalid file URL.
  expect(requests[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(requests[0].body).toContain('filename=report.md');
  expect(requests[0].body).toContain('fixture document bytes');
  expect(requests[0].body).toContain('[REDACTED]');
  expect(requests[0].body).not.toContain('alpha');
});
