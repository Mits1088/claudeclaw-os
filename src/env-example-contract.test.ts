import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const example = fs.readFileSync(path.resolve(__dirname, '..', '.env.example'), 'utf8');

describe('.env.example release-critical defaults', () => {
  it('documents the current interactive timeout default', () => {
    expect(example).toContain('# AGENT_TIMEOUT_MS=900000');
    expect(example).toContain('# AGENT_IDLE_TIMEOUT_MS=900000');
    expect(example).toContain('# AGENT_MAX_RUNTIME_MS=3600000');
    expect(example).toContain('Default: 900000 ms (15 minutes).');
    expect(example).not.toContain('Default: 300000 (5 min)');
  });

  it('documents streaming, transport, and write defaults', () => {
    expect(example).toContain('# STREAM_STRATEGY=global-throttle');
    expect(example).toContain('# CODEX_TRANSPORT=sdk');
    expect(example).toContain('# CODEX_DANGER_WRITE=false');
    expect(example).toContain('# SHOW_COST_FOOTER=compact');
    expect(example).toContain('# AGENT_MAX_TURNS=30');
  });

  it('does not imply native OpenAI is gated by experimental ACP', () => {
    expect(example).toContain('It does not gate native OpenAI.');
    expect(example).toContain('Native OpenAI is a stable provider and does not require ENABLE_ACP.');
  });

  it('keeps Windows upgrade and owner-identity guidance visible', () => {
    expect(example).toContain('Existing unquoted Windows paths are corrected by `npm run migrate`.');
    expect(example).toContain('CLAUDECLAW_OWNER_NAME=User');
  });

  it('marks voice-mode work as experimental without downgrading text War Room', () => {
    expect(example).toContain('Voice and War Room voice mode are experimental.');
    expect(example).toContain('Text War Room is validated.');
  });
});
