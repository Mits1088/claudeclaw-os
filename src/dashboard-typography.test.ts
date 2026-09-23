import { afterAll, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, string>([
  ['claudeclaw.textWeight', 'invalid'],
]);
let storageBlocked = false;
const properties = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem(key: string) {
    if (storageBlocked) throw new Error('Storage unavailable');
    return stored.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    if (storageBlocked) throw new Error('Storage unavailable');
    stored.set(key, value);
  },
});

vi.stubGlobal('document', {
  documentElement: {
    style: {
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
    },
  },
});

const modulePath = '../web/src/lib/typography.ts';
const typography = await import(/* @vite-ignore */ modulePath) as {
  textWeight: { value: number };
  setTextWeight: (next: number) => void;
};

afterAll(() => {
  typography.setTextWeight(450);
  vi.unstubAllGlobals();
});

describe('dashboard text weight preference', () => {
  it('defaults invalid storage to 450 and applies its CSS weight shift', () => {
    expect(typography.textWeight.value).toBe(450);
    expect(stored.get('claudeclaw.textWeight')).toBe('450');
    expect(properties.get('--text-weight-shift')).toBe('50');
  });

  it('rounds to 25-point steps, clamps to the supported range, and persists choices', () => {
    typography.setTextWeight(463);
    expect(typography.textWeight.value).toBe(475);
    expect(stored.get('claudeclaw.textWeight')).toBe('475');
    expect(properties.get('--text-weight-shift')).toBe('75');

    typography.setTextWeight(999);
    expect(typography.textWeight.value).toBe(600);
    expect(properties.get('--text-weight-shift')).toBe('200');

    typography.setTextWeight(399);
    expect(typography.textWeight.value).toBe(400);
    expect(properties.get('--text-weight-shift')).toBe('0');

    typography.setTextWeight(Number.NaN);
    expect(typography.textWeight.value).toBe(450);
  });

  it('keeps applying changes when browser storage is blocked', () => {
    storageBlocked = true;
    expect(() => typography.setTextWeight(525)).not.toThrow();
    expect(typography.textWeight.value).toBe(525);
    expect(properties.get('--text-weight-shift')).toBe('125');
    storageBlocked = false;
  });
});
