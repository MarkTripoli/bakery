import {
  createTranslator,
  type MessageArguments,
  type MessageKey,
  type SupportedLocale,
  type TextDirection,
  type Translator,
} from "@bakery/i18n";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import * as UI from "@bakery/ui";
import {
  browserTimeZone,
  initialLocale,
  type Presentation,
} from "./presentation.ts";

export type I18nContextValue = {
  readonly locale: SupportedLocale;
  readonly direction: TextDirection;
  /** IANA zone dates are formatted in: the preference, else the browser's. */
  readonly timeZone: string;
  readonly translate: Translator;
  /**
   * Adopts the server's presentation once the session loads. The server wins
   * over the cache and the browser, and a settled choice is cached for the
   * next first paint. A no-op for development fixture locale overrides.
   */
  readonly applyServerPresentation: (
    presentation: Presentation,
    options?: { readonly persist?: boolean },
  ) => void;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function fixtureLocaleOverride(): string | null {
  if (import.meta.env.DEV && location.pathname.startsWith("/__fixtures__/")) {
    return new URLSearchParams(location.search).get("locale");
  }
  return null;
}

type PresentationState = Presentation;

function initialPresentation(): PresentationState {
  const cached = UI.readStoredLocale();
  const locale = initialLocale({
    fixtureLocale: fixtureLocaleOverride(),
    cachedLocale: cached?.locale ?? null,
    browserLocales: globalThis.navigator?.languages ?? ["en"],
  });
  return {
    locale,
    direction: cached !== null && cached.locale === locale
      ? cached.dir
      : locale === "ar-XB"
      ? "rtl"
      : "ltr",
    timeZone: browserTimeZone(),
  };
}

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const [presentation, setPresentation] = useState(initialPresentation);
  const [fixtureLocked] = useState(() => fixtureLocaleOverride() !== null);
  const applyServerPresentation = useCallback((
    next: Presentation,
    options: { readonly persist?: boolean } = {},
  ) => {
    if (fixtureLocked) return;
    // Only a settled answer is cached; a provisional one (the organization's
    // preferences are still loading) must not replace a better cached value.
    if (options.persist !== false) {
      UI.persistLocale({ locale: next.locale, dir: next.direction });
    }
    setPresentation((current) =>
      current.locale === next.locale &&
        current.direction === next.direction &&
        current.timeZone === next.timeZone
        ? current
        : next
    );
  }, [fixtureLocked]);
  const { direction, locale, timeZone } = presentation;
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    direction,
    timeZone,
    translate: createTranslator({ locale, surface: "web-shell" }),
    applyServerPresentation,
  }), [applyServerPresentation, direction, locale, timeZone]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within I18nProvider");
  return value;
}

export function I18nText({
  id,
  values,
}: {
  readonly id: MessageKey;
  readonly values?: MessageArguments;
}) {
  return <>{useI18n().translate(id, values)}</>;
}
