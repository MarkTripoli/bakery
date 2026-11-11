export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = Exclude<Theme, "system">;

export const THEME_STORAGE_KEY = "bakery.theme.v1";
const DARK_SCHEME = "(prefers-color-scheme: dark)";

export function parseTheme(value: unknown): Theme {
  switch (value) {
    case "system":
    case "light":
    case "dark":
      return value;
    default:
      return "system";
  }
}

export function resolveTheme(
  theme: Theme,
  prefersDark = typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia(DARK_SCHEME).matches,
): ResolvedTheme {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

export function readStoredTheme(): Theme {
  try {
    return parseTheme(globalThis.localStorage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function applyThemeToDocument(theme: Theme): ResolvedTheme {
  const resolvedTheme = resolveTheme(theme);
  const root = globalThis.document?.documentElement;
  if (root) {
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
  }
  return resolvedTheme;
}

export function persistTheme(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage is an optional browser capability.
  }
}

export function themeMediaQuery(): MediaQueryList | null {
  return typeof globalThis.matchMedia === "function"
    ? globalThis.matchMedia(DARK_SCHEME)
    : null;
}
