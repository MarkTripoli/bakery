import type { ButtonHTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { Icon } from "./Icon.tsx";
import { useTheme } from "./ThemeProvider.tsx";
import "./atoms.css";

export type ThemeToggleProps =
  & SemanticNativeProps<ButtonHTMLAttributes<HTMLButtonElement>>
  & {
    /** Accessible name; also drives the pressed-state label ("Switch theme"). */
    label: string;
  };

/**
 * Cycles light/dark through the ambient `ThemeProvider`, for the quiet
 * 44x44 button the Paper auth artboards place in `.form-bottom`
 * (auth.css:9 `.theme-switch`; auth.js `themeButton()`).
 */
export function ThemeToggle({ label, ...props }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <button
      aria-label={label}
      className="ui-icon-button ui-theme-toggle"
      onClick={() => setTheme(dark ? "light" : "dark")}
      type="button"
      {...props}
      aria-pressed={dark}
      data-state={dark ? "pressed" : "default"}
      data-ui-component="themeToggle"
      data-variant="quiet"
    >
      {
        /* auth.js `themeButton()` renders `icon('sun')` in both themes; the
          pressed state is carried by `aria-pressed`, not by the glyph. */
      }
      <Icon size="large">
        <path d="M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </Icon>
    </button>
  );
}
