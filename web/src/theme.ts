export const THEMES = [
  'default',
  'contrast',
  'coral',
  'forest',
  'harbor',
  'midnight',
  'mono',
  'paper',
] as const;
export type Theme = (typeof THEMES)[number];

const KEY = 'recode.theme';

export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && (THEMES as readonly string[]).includes(stored)) return stored as Theme;
  } catch {
    // storage unavailable (private mode): fall back to the default theme
  }
  return 'default';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // not persisted
  }
}
