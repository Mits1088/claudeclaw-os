import { effect, signal } from '@preact/signals';

const STORAGE_KEY = 'claudeclaw.textWeight';
const MIN_WEIGHT = 400;
const MAX_WEIGHT = 600;
const WEIGHT_STEP = 25;
const DEFAULT_WEIGHT = 450;

function normalizeTextWeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WEIGHT;
  const rounded = MIN_WEIGHT + Math.round((value - MIN_WEIGHT) / WEIGHT_STEP) * WEIGHT_STEP;
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, rounded));
}

function loadInitial(): number {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved !== null && saved.trim() !== '') {
        const parsed = Number(saved);
        if (Number.isFinite(parsed)) return normalizeTextWeight(parsed);
      }
    }
  } catch {}
  return DEFAULT_WEIGHT;
}

export const textWeight = signal<number>(loadInitial());

effect(() => {
  const value = textWeight.value;
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--text-weight-shift', String(value - MIN_WEIGHT));
    }
  } catch {}
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, String(value));
  } catch {}
});

export function setTextWeight(next: number) {
  textWeight.value = normalizeTextWeight(next);
}
