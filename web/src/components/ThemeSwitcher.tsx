import { useState } from 'react';
import { applyTheme, loadTheme, THEMES, type Theme } from '../theme';

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  return (
    <label className="theme-switcher">
      <span className="text-sm text-muted">Theme</span>
      <select
        className="select"
        aria-label="Theme"
        value={theme}
        onChange={(event) => {
          const next = event.target.value as Theme;
          setTheme(next);
          applyTheme(next);
        }}
      >
        {THEMES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
