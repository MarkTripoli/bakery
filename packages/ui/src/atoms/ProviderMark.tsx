import { type HTMLAttributes, useLayoutEffect, useRef, useState } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { PROVIDER_MARKS } from "./provider-marks.ts";
import "./atoms.css";

export type ProviderMarkProps =
  & SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>
  & {
    /** The provider the server names, such as "sentry". One with no mark gets a letter tile. */
    provider: string;
    /** The provider's name as people read it. The tile shows its first letter; a mark that stands alone is named by it. */
    name: string;
    /** `row` is a 24px slot in a list; `header` is a 32px slot in a page header or a chooser. */
    size?: "row" | "header";
    /**
     * Set when the mark stands alone, so its accessible name is the provider's
     * name. Left off beside the name in text, where the mark is hidden from
     * assistive technology.
     */
    standalone?: boolean;
  };

/**
 * A provider's mark in a fixed square slot, the same size and centre line for
 * every provider so names start at one x. The vendor file is never recoloured:
 * the light file shows on a light surface and the dark file on a dark one. A
 * provider with no mark, or one the registry does not know, gets a letter
 * tile. Never a link, and its glyph never reads larger than Bakery's own mark:
 * a file with its own clear space is drawn at twice the size and overflows the
 * slot, so the slot, and the x where names start, stay the same.
 */
export function ProviderMark(
  { provider, name, size = "row", standalone = false, ...props }:
    ProviderMarkProps,
) {
  const element = useRef<HTMLSpanElement>(null);
  const [darkTheme, setDarkTheme] = useState(false);
  useLayoutEffect(() => {
    const root = element.current;
    if (!root) return;
    // Follow DOM themes too, as LogoMark does: no ThemeProvider is needed.
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
  const files = Object.hasOwn(PROVIDER_MARKS, provider)
    ? PROVIDER_MARKS[provider]
    : undefined;
  const label = standalone ? { "aria-label": name, role: "img" } : {
    "aria-hidden": true,
  };
  return (
    <span
      className={`ui-provider-mark ui-provider-mark--${size}`}
      {...label}
      {...props}
      data-provider={provider}
      data-clear-space={files?.clearSpace === true ? "true" : undefined}
      data-state={files === undefined ? "tile" : "mark"}
      data-ui-component="providerMark"
      data-variant={size}
      ref={element}
    >
      {files === undefined
        ? (
          <span className="ui-provider-mark__tile">
            {name.trim().charAt(0)}
          </span>
        )
        : (
          files.crop === undefined
            ? (
              <img
                alt=""
                className="ui-provider-mark__art"
                src={darkTheme ? files.dark : files.light}
              />
            )
            : (
              <svg
                aria-hidden="true"
                className="ui-provider-mark__art"
                viewBox={files.crop.viewBox}
              >
                <image
                  height={files.crop.height}
                  href={darkTheme ? files.dark : files.light}
                  width={files.crop.width}
                />
              </svg>
            )
        )}
    </span>
  );
}
