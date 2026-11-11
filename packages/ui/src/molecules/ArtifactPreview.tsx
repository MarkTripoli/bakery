import { type AnchorHTMLAttributes, type ReactNode, useId } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import "../collaboration.css";

export type ArtifactPreviewProps =
  & SemanticNativeProps<AnchorHTMLAttributes<HTMLAnchorElement>>
  & {
    meta?: ReactNode;
    title: ReactNode;
  };

/**
 * A linked artifact card in a task transcript (Paper HU-0 plan card). The
 * link is named by its title and described by its metadata line.
 */
export function ArtifactPreview(
  { meta, title, ...props }: ArtifactPreviewProps,
) {
  const id = useId();
  return (
    <a
      aria-describedby={meta ? `${id}-meta` : undefined}
      aria-labelledby={`${id}-title`}
      className="ui-artifact-preview"
      {...props}
      data-state="default"
      data-ui-component="artifactPreview"
      data-variant="card"
    >
      <IconGlyph name="file" />
      <span className="ui-artifact-preview__text">
        <span className="ui-artifact-preview__title" id={`${id}-title`}>
          {title}
        </span>
        {meta
          ? (
            <span className="ui-artifact-preview__meta" id={`${id}-meta`}>
              {meta}
            </span>
          )
          : null}
      </span>
      <IconGlyph name="arrow" />
    </a>
  );
}
