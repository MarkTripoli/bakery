import { type HTMLAttributes, useLayoutEffect, useRef, useState } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { logo } from "../brand/logo-assets.ts";
import "./atoms.css";

const artwork = {
  compact: {
    light: logo({ art: "mark", variant: "color-light", size: 24 }),
    dark: logo({ art: "mark", variant: "color-dark", size: 24 }),
  },
  rail: {
    light: logo({ art: "mark", variant: "color-light", size: 28 }),
    dark: logo({ art: "mark", variant: "color-dark", size: 28 }),
  },
  wordmark: {
    light: logo({ art: "lockup", variant: "color-light" }),
    dark: logo({ art: "lockup", variant: "color-dark" }),
  },
};

export type LogoMarkProps =
  & SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>
  & {
    appearance?: "default" | "inverse";
    variant?: "compact" | "wordmark" | "rail";
  };

export function LogoMark(
  { appearance = "default", variant = "compact", ...props }: LogoMarkProps,
) {
  const element = useRef<HTMLSpanElement>(null);
  const [darkTheme, setDarkTheme] = useState(false);
  useLayoutEffect(() => {
    const root = element.current;
    if (!root) return;
    // Follow DOM themes too: Paper and Storybook need no ThemeProvider context.
    const update = () =>
      setDarkTheme(root.closest('[data-theme="dark"]') !== null);
    const observer = new MutationObserver(update);
    for (
      let ancestor: Element | null = root;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      observer.observe(ancestor, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    }
    update();
    return () => observer.disconnect();
  }, []);
  const pair = artwork[variant];
  const light = appearance === "inverse" ? pair.dark : pair.light;
  const dark = appearance === "inverse" ? pair.light : pair.dark;
  const selected = darkTheme ? dark : light;
  const art = variant === "wordmark" ? "lockup" : "mark";
  return (
    <span
      aria-label="Bakery"
      className={[
        "ui-logo-mark",
        appearance === "inverse" && "ui-logo-mark--inverse",
        `ui-logo-mark--${variant}`,
      ].filter(Boolean).join(" ")}
      role="img"
      {...props}
      data-state={appearance}
      data-ui-component="logoMark"
      data-variant={variant}
      ref={element}
    >
      <img
        alt=""
        className={`ui-logo-mark__art--${darkTheme ? "dark" : "light"}`}
        data-logo-art={art}
        data-logo-variant={selected.variant}
        src={selected.src}
      />
    </span>
  );
}
