import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type AppearanceMode = 'dark' | 'light' | 'system';
type AppearanceModule = {
  appearanceMode: { value: AppearanceMode };
  resolvedAppearance: { value: 'dark' | 'light' };
  setAppearanceMode: (mode: AppearanceMode) => void;
};

const stored = new Map<string, string>([
  ['claudeclaw.appearanceMode', 'sepia'],
]);
let storageBlocked = false;
let systemIsDark = false;
const mediaListeners = new Set<() => void>();
const attributes = new Map<string, string>();

const storage = {
  getItem(key: string) {
    if (storageBlocked) throw new Error('Storage unavailable');
    return stored.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    if (storageBlocked) throw new Error('Storage unavailable');
    stored.set(key, value);
  },
};

const mediaQuery = {
  get matches() { return systemIsDark; },
  addEventListener(type: string, listener: () => void) {
    if (type === 'change') mediaListeners.add(listener);
  },
  removeEventListener(type: string, listener: () => void) {
    if (type === 'change') mediaListeners.delete(listener);
  },
};

function emitSystemAppearance(isDark: boolean) {
  systemIsDark = isDark;
  for (const listener of [...mediaListeners]) listener();
}

let appearance: AppearanceModule;

beforeAll(async () => {
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
    },
  });
  vi.stubGlobal('window', {
    matchMedia: vi.fn(() => mediaQuery),
  });

  // Keep browser-only DOM types out of the server build, like the other UI tests.
  const modulePath = '../web/src/lib/appearance.ts';
  appearance = await import(/* @vite-ignore */ modulePath) as AppearanceModule;
});

afterAll(() => {
  appearance.setAppearanceMode('dark');
  vi.unstubAllGlobals();
});

describe('dashboard appearance preference', () => {
  it('defaults invalid stored values to dark and persists valid choices', () => {
    expect(appearance.appearanceMode.value).toBe('dark');
    expect(appearance.resolvedAppearance.value).toBe('dark');
    expect(attributes.get('data-appearance')).toBe('dark');
    expect(stored.get('claudeclaw.appearanceMode')).toBe('dark');

    appearance.setAppearanceMode('light');

    expect(appearance.appearanceMode.value).toBe('light');
    expect(appearance.resolvedAppearance.value).toBe('light');
    expect(attributes.get('data-appearance')).toBe('light');
    expect(stored.get('claudeclaw.appearanceMode')).toBe('light');
  });

  it('tracks system changes only while System is selected', () => {
    emitSystemAppearance(false);
    appearance.setAppearanceMode('system');

    expect(appearance.resolvedAppearance.value).toBe('light');
    expect(mediaListeners.size).toBe(1);

    emitSystemAppearance(true);
    expect(appearance.resolvedAppearance.value).toBe('dark');
    expect(attributes.get('data-appearance')).toBe('dark');

    appearance.setAppearanceMode('light');
    expect(mediaListeners.size).toBe(0);

    emitSystemAppearance(true);
    expect(appearance.resolvedAppearance.value).toBe('light');
    expect(attributes.get('data-appearance')).toBe('light');
  });

  it('keeps applying choices when browser storage is blocked', () => {
    storageBlocked = true;
    expect(() => appearance.setAppearanceMode('dark')).not.toThrow();
    expect(appearance.resolvedAppearance.value).toBe('dark');
    expect(attributes.get('data-appearance')).toBe('dark');
    storageBlocked = false;
  });
});
