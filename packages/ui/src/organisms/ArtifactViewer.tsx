import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useId,
} from "react";
import "../artifacts.css";
import {
  HEADING,
  INLINE_LINK,
  INLINE_TOKEN,
  MOST_TABLE_CELLS,
  readTable,
  startsTable,
} from "../markdown-lines.ts";

export type ArtifactViewerContent =
  | {
    readonly kind: "text" | "markdown" | "patch" | "log";
    readonly text: string;
    /**
     * Show the first lines under a fade, at the panel's cap (#437).
     *
     * A side panel is meant to tell a person what a file is, not to become the
     * reader: a long file pushes Download and the tabs below the fold. The
     * artifact page shows the whole file and never sets this.
     */
    readonly cut?: boolean;
  }
  | {
    readonly kind: "image";
    readonly src: string;
    readonly alt: string;
    readonly unavailableLabel: string;
  }
  | {
    /**
     * A player that loads only what it plays: `preload="none"`, never
     * autoplayed, the browser's own controls. `src` is a path on this origin, an
     * http(s) URL, or a `blob:` URL the page itself verified; anything else is
     * refused rather than handed to the element.
     */
    readonly kind: "video" | "audio";
    readonly src: string;
    /** Names the player for assistive technology, such as the file name. */
    readonly label: string;
    readonly unavailableLabel: string;
    /** Called when the browser cannot play the file, so the page can say so. */
    readonly onError?: () => void;
  }
  | { readonly kind: "unsupported"; readonly message: ReactNode };
/**
 * True inside a surface that already names the preview as a region (the task
 * artifact pane). A viewer there is a labelled group, not a second landmark with
 * the same name, so a person moving by landmarks meets one "Preview", not two.
 */
export const artifactViewerRegion = createContext(false);

export type ArtifactViewerProps = {
  readonly label: ReactNode;
  readonly content: ArtifactViewerContent;
  readonly state?: "ready" | "loading" | "error";
  /** `full` lets an image or player take the room it is given instead of a panel's. */
  readonly size?: "panel" | "full";
  readonly footer?: ReactNode;
  readonly "data-testid"?: string;
};

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(INLINE_TOKEN)
    .map((part, index) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={index}>{part.slice(1, -1)}</code>;
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("*") && part.endsWith("*")) {
        return <em key={index}>{part.slice(1, -1)}</em>;
      }
      const link = INLINE_LINK.exec(part);
      if (link?.[1] && link[2] && /^(https?:\/\/|mailto:|#)/i.test(link[2])) {
        return (
          <a key={index} href={link[2]} rel="noopener noreferrer">{link[1]}</a>
        );
      }
      return part;
    });
}

const RULE_LINE = /^(-{3,}|\*{3,}|_{3,})\s*$/;

// Markdown is constructed exclusively from React text nodes and an allowlist of elements.
// Raw HTML, embedded media, and non-web link schemes never become executable markup.
function markdown(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let cellsLeft = MOST_TABLE_CELLS;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const key = index;
    if (!line.trim()) {
      index++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index]?.startsWith("```")) {
        code.push(lines[index++] ?? "");
      }
      index++;
      blocks.push(
        <pre dir="ltr" key={key}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (RULE_LINE.test(line)) {
      blocks.push(<hr key={key} />);
      index++;
      continue;
    }
    if (startsTable(lines, index)) {
      const { header, rows, overflow, cells, end } = readTable(
        lines,
        index,
        cellsLeft,
      );
      cellsLeft -= cells;
      index = end;
      if (header.length > 0) {
        blocks.push(
          <div
            className="ui-artifact-viewer__table"
            key={key}
            role="group"
            aria-label={header.join(", ")}
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  {header.map((cell, column) => (
                    <th key={column} scope="col">{inlineMarkdown(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, at) => (
                  <tr key={at}>
                    {header.map((_, column) => (
                      <td key={column}>{inlineMarkdown(row[column] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      }
      if (overflow.length > 0) {
        blocks.push(
          <pre dir="ltr" data-ui-overflow="wrap" key={`${key}-rest`}>
            <code>{overflow.join("\n")}</code>
          </pre>,
        );
      }
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1] && heading[2]) {
      blocks.push(
        createElement(
          `h${Math.max(2, heading[1].length)}`,
          { key },
          inlineMarkdown(heading[2]),
        ),
      );
      index++;
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index] ?? "")) {
        items.push(
          <li key={index}>
            {inlineMarkdown((lines[index++] ?? "").replace(/^[-*+]\s+/, ""))}
          </li>,
        );
      }
      blocks.push(<ul key={key}>{items}</ul>);
      continue;
    }
    const paragraph = [line];
    index++;
    while (
      index < lines.length && lines[index]?.trim() &&
      !/^(#{1,6}\s|[-*+]\s|```)/.test(lines[index] ?? "") &&
      !startsTable(lines, index) && !RULE_LINE.test(lines[index] ?? "")
    ) paragraph.push(lines[index++] ?? "");
    blocks.push(<p key={key}>{inlineMarkdown(paragraph.join("\n"))}</p>);
  }
  return blocks;
}

function preview(content: ArtifactViewerContent): ReactNode {
  switch (content.kind) {
    case "markdown":
      return (
        <div
          className="ui-artifact-viewer__markdown"
          data-cut={content.cut === true ? "panel" : undefined}
        >
          {markdown(content.text)}
        </div>
      );
    case "text":
    case "log":
    case "patch":
      return (
        <pre
          // Code and log text read left to right whatever the page direction.
          dir="ltr"
          data-ui-overflow="wrap"
          data-cut={content.cut === true ? "panel" : undefined}
        >
          <code>{content.text}</code>
        </pre>
      );
    case "image":
      return content.src.startsWith("blob:")
        ? (
          <div className="ui-artifact-viewer__image">
            <img src={content.src} alt={content.alt} />
          </div>
        )
        : <p role="alert">{content.unavailableLabel}</p>;
    case "video":
    case "audio": {
      // A src the player must not be given: a script URL or any other scheme.
      // `blob:` is allowed because a surface that fetched the bytes and checked
      // their digest has them only as a blob, and handing them over is the point.
      const allowed = /^(\/(?!\/)|https?:\/\/|blob:)/.test(content.src);
      if (!allowed) return <p role="alert">{content.unavailableLabel}</p>;
      return content.kind === "video"
        ? (
          <div className="ui-artifact-viewer__media">
            <video
              aria-label={content.label}
              controls
              onError={content.onError}
              preload="none"
              src={content.src}
            />
          </div>
        )
        : (
          <div className="ui-artifact-viewer__media">
            <audio
              aria-label={content.label}
              controls
              onError={content.onError}
              preload="none"
              src={content.src}
            />
          </div>
        );
    }
    case "unsupported":
      return (
        <div className="ui-artifact-viewer__unavailable">{content.message}</div>
      );
    default: {
      const unreachable: never = content;
      return unreachable;
    }
  }
}

export function ArtifactViewer(
  {
    label,
    content,
    footer,
    size = "panel",
    state = "ready",
    "data-testid": testId,
  }: ArtifactViewerProps,
) {
  const titleId = useId();
  const withinRegion = useContext(artifactViewerRegion);
  return createElement(
    withinRegion ? "div" : "section",
    {
      className: "ui-artifact-viewer",
      ...(withinRegion ? { role: "group" } : {}),
      "aria-labelledby": titleId,
      "aria-busy": state === "loading" || undefined,
      "data-testid": testId,
      "data-ui-component": "artifactViewer",
      "data-variant": content.kind,
      "data-size": size,
      "data-state": state,
    },
    /* Opened full size, the page names the file above the card: the heading
      stays only to name the card for assistive technology, and is not shown. */
    <h2 id={titleId} hidden={size === "full"}>{label}</h2>,
    state === "ready" ? preview(content) : null,
    footer,
  );
}
