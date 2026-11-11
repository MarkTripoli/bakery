import { createElement, type ReactNode, useId } from "react";
import "../artifacts.css";

export type ArtifactViewerContent =
  | {
    readonly kind: "text" | "markdown" | "patch" | "log";
    readonly text: string;
  }
  | {
    readonly kind: "image";
    readonly src: string;
    readonly alt: string;
    readonly unavailableLabel: string;
  }
  | { readonly kind: "unsupported"; readonly message: ReactNode };
export type ArtifactViewerProps = {
  readonly label: ReactNode;
  readonly content: ArtifactViewerContent;
  readonly state?: "ready" | "loading" | "error";
  readonly footer?: ReactNode;
  readonly "data-testid"?: string;
};

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g)
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
      const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
      if (link?.[1] && link[2] && /^(https?:\/\/|mailto:|#)/i.test(link[2])) {
        return (
          <a key={index} href={link[2]} rel="noopener noreferrer">{link[1]}</a>
        );
      }
      return part;
    });
}

// Markdown is constructed exclusively from React text nodes and an allowlist of elements.
// Raw HTML, embedded media, and non-web link schemes never become executable markup.
function markdown(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
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
      blocks.push(<pre key={key}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
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
      !/^(#{1,6}\s|[-*+]\s|```)/.test(lines[index] ?? "")
    ) paragraph.push(lines[index++] ?? "");
    blocks.push(<p key={key}>{inlineMarkdown(paragraph.join("\n"))}</p>);
  }
  return blocks;
}

function preview(content: ArtifactViewerContent): ReactNode {
  switch (content.kind) {
    case "markdown":
      return (
        <div className="ui-artifact-viewer__markdown">
          {markdown(content.text)}
        </div>
      );
    case "text":
    case "log":
    case "patch":
      return <pre data-ui-overflow="wrap"><code>{content.text}</code></pre>;
    case "image":
      return content.src.startsWith("blob:")
        ? (
          <div className="ui-artifact-viewer__image">
            <img src={content.src} alt={content.alt} />
          </div>
        )
        : <p role="alert">{content.unavailableLabel}</p>;
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
  { label, content, footer, state = "ready", "data-testid": testId }:
    ArtifactViewerProps,
) {
  const titleId = useId();
  return (
    <section
      className="ui-artifact-viewer"
      aria-labelledby={titleId}
      aria-busy={state === "loading" || undefined}
      data-testid={testId}
      data-ui-component="artifactViewer"
      data-variant={content.kind}
      data-state={state}
    >
      <h2 id={titleId}>{label}</h2>
      {state === "ready" ? preview(content) : null}
      {footer}
    </section>
  );
}
