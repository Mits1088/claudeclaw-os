import { effect, signal } from '@preact/signals';

export type AppearanceMode = 'dark' | 'light' | 'system';
export type ResolvedAppearance = 'dark' | 'light';

const STORAGE_KEY = 'claudeclaw.appearanceMode';

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === 'dark' || value === 'light' || value === 'system';
}

function loadInitial(): AppearanceMode {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isAppearanceMode(saved)) return saved;
    }
  } catch {}
  // Preserve the dashboard's existing appearance for first-time visitors.
  return 'dark';
}

function systemAppearance(query?: MediaQueryList | null): ResolvedAppearance {
  if (query) return query.matches ? 'dark' : 'light';
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch {}
  return 'dark';
}

function applyAppearance(next: ResolvedAppearance) {
  resolvedAppearance.value = next;
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-appearance', next);
    }
  } catch {}
}

export const appearanceMode = signal<AppearanceMode>(loadInitial());
export const resolvedAppearance = signal<ResolvedAppearance>(
  appearanceMode.value === 'system' ? systemAppearance() : appearanceMode.value,
);

effect(() => {
  const mode = appearanceMode.value;

  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, mode);
  } catch {}

  if (mode !== 'system') {
    applyAppearance(mode);
    return;
  }

  let query: MediaQueryList | null = null;
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      query = window.matchMedia('(prefers-color-scheme: dark)');
    }
  } catch {}

  applyAppearance(systemAppearance(query));
  if (!query) return;

  const onChange = () => applyAppearance(systemAppearance(query));
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query?.removeEventListener('change', onChange);
  }

  // Older WebKit exposes the deprecated MediaQueryList listener methods.
  query.addListener?.(onChange);
  return () => query?.removeListener?.(onChange);
});

export function setAppearanceMode(next: AppearanceMode) {
  if (isAppearanceMode(next)) appearanceMode.value = next;
}
