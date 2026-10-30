/** Same key as the inline script in ui/index.html. Keep those two in sync. */
export const THEME_STORAGE_KEY = "floodsense-theme";

export type ThemeName = "light" | "dark";

export function readTheme(): ThemeName {
  if (typeof document !== "undefined") {
    const current = document.documentElement.dataset.theme;
    if (current === "light" || current === "dark") return current;
  }
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* private mode */
  }
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

/** Writes localStorage. Call this from the toggle, not on every mount, so an unset preference can still follow the OS. */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* private mode */
  }
}
