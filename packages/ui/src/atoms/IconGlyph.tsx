import type { ReactNode } from "react";
import { Icon, type IconProps } from "./Icon.tsx";

/**
 * Named glyphs, path data copied verbatim from the Paper mock's `ICONS`
 * table (`docs/technical-design/auth-mocks/auth.js`) so every consumer
 * renders the exact same shapes the design references show — same pattern
 * as `AuthEntry.tsx`'s `STEP_ICON_PATHS`, generalised for reuse outside
 * that one template (settings rows, notice tone icons, list rows).
 */
export type IconGlyphName =
  | "alert"
  | "arrow"
  | "back"
  | "building"
  | "check"
  | "computer"
  | "document"
  | "key"
  | "lock"
  | "mail"
  | "person"
  | "phone"
  | "plug"
  | "shield"
  | "chevron-down"
  | "work-list"
  | "applications"
  | "terminal"
  | "monitor"
  | "integration"
  | "lightning"
  | "settings-sun"
  | "search"
  | "list-search"
  | "menu"
  | "phone-status"
  | "listening"
  | "server"
  | "laptop"
  | "book"
  | "plus"
  | "chevron-up"
  | "chevron-right"
  | "file"
  | "clock"
  | "refresh"
  | "caution"
  | "plan"
  | "chat"
  | "chevron-left"
  | "lanes";

// Additional shell glyphs: approved K-0 9VJ-0/9ZB-0 exports; listening bars:
// AR1-0. Exact paths and viewports, theme-aware ink; never a font substitute.
const GLYPH_PATHS: Record<IconGlyphName, ReactNode> = {
  "chevron-down": (
    <>
      <path
        d="m6 9 6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "work-list": (
    <>
      <path
        d="M8 6h12M8 12h12M8 18h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 6h1M3 12h1M3 18h1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "applications": (
    <>
      <rect
        x="3"
        y="3"
        width="7"
        height="7"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="14"
        y="3"
        width="7"
        height="7"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="3"
        y="14"
        width="7"
        height="7"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="14"
        y="14"
        width="7"
        height="7"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "terminal": (
    <>
      <path
        d="m5 6 6 6-6 6M14 18h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "monitor": (
    <>
      <rect
        x="3"
        y="4"
        width="18"
        height="13"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 21h8M12 17v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "integration": (
    <>
      <path d="M8 12h8" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M9 7v2a3 3 0 0 1-3 3H4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M15 17v-2a3 3 0 0 1 3-3h2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <circle
        cx="9"
        cy="5"
        r="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <circle
        cx="15"
        cy="19"
        r="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </>
  ),
  "lightning": (
    <>
      <path
        d="m13 2-9 12h7l-1 8 10-12h-7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "settings-sun": (
    <>
      <circle
        cx="12"
        cy="12"
        r="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  // Approved list mobile 8SE-0 / AD7-0, lines 61-63; opt-in, not shell search.
  "list-search": (
    <>
      <circle
        cx="10.5"
        cy="10.5"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="m16 16 4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  "search": (
    <>
      <circle
        cx="11"
        cy="11"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="m20 20-3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </>
  ),
  "menu": (
    <>
      <path
        d="M4 6h16M4 12h16M4 18h16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </>
  ),
  "phone-status": (
    <>
      <g stroke="none">
        <path
          d="M3.7 13H2.5a1 1 0 0 0-1 1v2.5a1 1 0 0 0 1 1h1.2a1 1 0 0 0 1-1V14a1 1 0 0 0-1-1m5.2-2.5H7.7a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1.2a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1M14.1 8h-1.2a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h1.2a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1m5.2-2.5h-1.2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h1.2a1 1 0 0 0 1-1v-10a1 1 0 0 0-1-1"
          fill="currentColor"
        />
        <path
          fillRule="evenodd"
          d="M36.57 7.8c2.49 0 4.88.92 6.68 2.58.14.13.36.12.49 0l1.3-1.27a.34.34 0 0 0 0-.5 12.55 12.55 0 0 0-16.93 0 .34.34 0 0 0 0 .5l1.3 1.26c.13.13.34.14.48 0a10 10 0 0 1 6.68-2.57m0 4.22a5.4 5.4 0 0 1 3.67 1.44c.14.13.35.13.48 0l1.3-1.33a.37.37 0 0 0-.01-.52 7.9 7.9 0 0 0-10.88 0 .37.37 0 0 0 0 .52l1.29 1.32c.13.14.34.14.48 0 1-.92 2.31-1.43 3.67-1.43m2.52 2.8q0 .15-.1.28l-2.18 2.45a.3.3 0 0 1-.24.11.3.3 0 0 1-.24-.1l-2.18-2.46a.43.43 0 0 1 .01-.56 3.44 3.44 0 0 1 4.82 0 .4.4 0 0 1 .11.28"
          clipRule="evenodd"
          fill="currentColor"
        />
        <path
          fillRule="evenodd"
          d="M70.5 5c2.05 0 3.08 0 3.88.34a4.3 4.3 0 0 1 2.28 2.28c.34.8.34 1.83.34 3.88s0 3.08-.34 3.88a4.3 4.3 0 0 1-2.28 2.28c-.8.34-1.83.34-3.88.34h-12c-2.05 0-3.08 0-3.88-.34a4.3 4.3 0 0 1-2.28-2.28c-.34-.8-.34-1.83-.34-3.88s0-3.08.34-3.88A4.3 4.3 0 0 1 54.62 5zM58.28 6c-1.85 0-2.77 0-3.48.36a3.3 3.3 0 0 0-1.44 1.44C53 8.5 53 9.43 53 11.28v.44c0 1.85 0 2.77.36 3.48a3.3 3.3 0 0 0 1.44 1.44c.7.36 1.63.36 3.48.36h12.44c1.85 0 2.77 0 3.48-.36a3.3 3.3 0 0 0 1.44-1.44c.36-.7.36-1.63.36-3.48v-.44c0-1.85 0-2.77-.36-3.48a3.3 3.3 0 0 0-1.44-1.44C73.5 6 72.57 6 70.72 6z"
          clipRule="evenodd"
          fill="currentColor"
          opacity="0.35"
        />
        <path
          d="M54 11c0-1.4 0-2.1.27-2.63a2.5 2.5 0 0 1 1.1-1.1C55.9 7 56.6 7 58 7h13c1.4 0 2.1 0 2.64.27q.72.37 1.09 1.1C75 8.9 75 9.6 75 11v1c0 1.4 0 2.1-.27 2.64a2.5 2.5 0 0 1-1.1 1.09C73.1 16 72.4 16 71 16H58c-1.4 0-2.1 0-2.63-.27a2.5 2.5 0 0 1-1.1-1.1C54 14.1 54 13.4 54 12z"
          fill="currentColor"
        />
        <path
          d="M78 9.5v4.08a2.2 2.2 0 0 0 1.33-2.04A2.2 2.2 0 0 0 78 9.5"
          fill="currentColor"
          opacity="0.35"
        />
      </g>
    </>
  ),
  server: (
    <>
      <rect
        x="3"
        y="3"
        width="18"
        height="7"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="3"
        y="14"
        width="18"
        height="7"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  laptop: (
    <>
      <rect
        x="3"
        y="4"
        width="18"
        height="13"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M1 21h22M9 17v4M15 17v4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </>
  ),
  listening: (
    <g fill="currentColor" stroke="none">
      <rect x="0" y="6" width="3" height="8" rx="2" />
      <rect x="6" y="2" width="3" height="16" rx="2" />
      <rect x="12" y="4.5" width="3" height="11" rx="2" />
    </g>
  ),
  alert: <path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v.1" />,
  // Library and New task glyphs: enterprise work-queue frame 5J-0.
  book: (
    <path d="M12 5c-4-3-8-2-9-1v15c3-2 6-2 9 0 3-2 6-2 9 0V4c-3-1-6-2-9 1Zm0 0v14" />
  ),
  plus: <path d="M12 4v16M4 12h16" />,
  // Queue group toggle and transcript artifact glyphs: frames E8-0 and HU-0.
  "chevron-up": <path d="m6 15 6-6 6 6" />,
  // Settings index row affordance: O-0 settings-index frame (phone).
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  file: <path d="M13 2H5v20h14V8zM13 2v6h6M8 12h8M8 16h8" />,
  // Conversation frames p-18-0: queued-turn clock, refresh and caution
  // notices, and the plan pane file.
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" />,
  caution: <path d="M12 3 2 20h20zM12 10v4M12 17v.5" />,
  plan: <path d="M6 3h9l4 4v14H6zM9 12h7M9 16h7" />,
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  "chevron-left": <path d="m15 6-6 6 6 6" />,
  lanes: <path d="M4 6h6M4 12h10M4 18h16M14 6h6" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  back: <path d="M19 12H5m6-6-6 6 6 6" />,
  building: <path d="M4 21V3h11v18m0-12h5v12M2 21h20M8 7h3m-3 4h3m-3 4h3" />,
  check: <path d="m5 12 4 4L19 6" />,
  computer: (
    <>
      <rect height="13" rx="2" width="18" x="3" y="3" />
      <path d="M8 21h8m-4-5v5" />
    </>
  ),
  document: (
    <>
      <rect height="18" rx="2" width="14" x="5" y="3" />
      <path d="M9 8h6m-6 4h6m-6 4h4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="m12 12 9 9m-5-5 3-3m0 6 3-3" />
    </>
  ),
  lock: (
    <>
      <rect height="11" rx="2" width="14" x="5" y="10" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
    </>
  ),
  mail: (
    <>
      <rect height="14" rx="2" width="18" x="3" y="5" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="7" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  phone: (
    <>
      <rect height="20" rx="3" width="12" x="6" y="2" />
      <path d="M10 18h4" />
    </>
  ),
  plug: <path d="M8 2v5m8-5v5M5 7h14v4a7 7 0 0 1-14 0V7Zm7 11v4" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
};

export type IconGlyphProps = Omit<IconProps, "children"> & {
  name: IconGlyphName;
};

/**
 * An `Icon` filled with one of the shared named glyph paths. The glyph group
 * owns the component's semantic metadata (the `Icon` `<svg>` around it stays
 * the `icon` owner, with its own size variant); a plain `<g>` inherits every
 * presentation property — `fill`, `stroke`, `stroke-width` — from that
 * `<svg>`, so the drawing is byte-identical to the bare paths.
 */
export function IconGlyph({ name, ...props }: IconGlyphProps) {
  return (
    <Icon
      {...props}
      {...(name === "phone-status"
        ? { width: 82, height: 22, viewBox: "0 0 82 22" }
        : name === "listening"
        ? { width: 15, height: 20, viewBox: "0 0 15 20" }
        : {})}
    >
      <g
        data-state="default"
        data-ui-component="iconGlyph"
        data-variant={name}
      >
        {GLYPH_PATHS[name]}
      </g>
    </Icon>
  );
}
