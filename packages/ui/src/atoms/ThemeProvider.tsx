import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import "../foundations/index.css";
import {
  applyThemeToDocument,
  persistTheme,
  readStoredTheme,
  type ResolvedTheme,
  resolveTheme,
  type Theme,
  themeMediaQuery,
} from "./theme.ts";
export type { ResolvedTheme, Theme } from "./theme.ts";

type ThemeContextValue = {
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  theme: Theme;
};
const ThemeContext = createContext<ThemeContextValue | null>(null);

export type ThemeProviderProps = {
  children: ReactNode;
  defaultTheme?: Theme;
  locale?: string;
  direction?: "ltr" | "rtl";
};

export function ThemeProvider({
  children,
  defaultTheme,
  direction = "ltr",
  locale,
}: ThemeProviderProps) {
  const ownsDocument = defaultTheme === undefined;
  const [theme, setThemeState] = useState<Theme>(() =>
    defaultTheme ?? readStoredTheme()
  );
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(defaultTheme ?? readStoredTheme())
  );

  const setTheme = useCallback((nextTheme: Theme) => {
    persistTheme(nextTheme);
    setThemeState(nextTheme);
    setResolvedTheme(
      ownsDocument ? applyThemeToDocument(nextTheme) : resolveTheme(nextTheme),
    );
  }, [ownsDocument]);

  useEffect(() => {
    const media = themeMediaQuery();
    if (!media || theme !== "system") return;
    const update = () => {
      setResolvedTheme(resolveTheme("system", media.matches));
      if (ownsDocument) applyThemeToDocument("system");
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [ownsDocument, theme]);

  useEffect(() => {
    if (ownsDocument) applyThemeToDocument(theme);
  }, [ownsDocument, theme]);

  useEffect(() => {
    if (!ownsDocument) return;
    const root = globalThis.document?.documentElement;
    if (!root) return;
    if (locale) root.lang = locale;
    root.dir = direction;
  }, [direction, locale, ownsDocument]);

  const value = useMemo(() => ({ resolvedTheme, setTheme, theme }), [
    resolvedTheme,
    setTheme,
    theme,
  ]);
  return (
    <ThemeContext.Provider value={value}>
      <div
        data-ui-component="themeProvider"
        data-state={theme === resolvedTheme ? "default" : "resolved"}
        data-theme={resolvedTheme}
        data-variant={theme}
        dir={direction}
        lang={locale}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
