import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type ArtifactDescriptorLabels = Readonly<{
  artifactId: ReactNode;
  version: ReactNode;
  digest: ReactNode;
  size: ReactNode;
  mediaType: ReactNode;
  provenance: ReactNode;
  link: ReactNode;
}>;

export type ArtifactDescriptorProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    artifactId: string;
    version: string;
    digest: string;
    size: string;
    mediaType: string;
    provenance: ReactNode;
    labels: ArtifactDescriptorLabels;
    href?: AnchorHTMLAttributes<HTMLAnchorElement>["href"];
  };

/** Immutable artifact metadata with a relative or HTTP(S) navigation target. */
export function isSafeArtifactHref(
  href: AnchorHTMLAttributes<HTMLAnchorElement>["href"],
): href is string {
  if (typeof href !== "string" || href.trim() === "") return false;
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
export function ArtifactDescriptor({
  artifactId,
  version,
  digest,
  size,
  mediaType,
  provenance,
  labels,
  href,
  ...props
}: ArtifactDescriptorProps) {
  return (
    <div
      className="ui-artifact-descriptor"
      {...props}
      data-state="immutable"
      data-ui-component="artifactDescriptor"
      data-variant="descriptor"
    >
      <dl>
        <div>
          <dt>{labels.artifactId}</dt>
          <dd>{artifactId}</dd>
        </div>
        <div>
          <dt>{labels.version}</dt>
          <dd>{version}</dd>
        </div>
        <div>
          <dt>{labels.digest}</dt>
          <dd data-rail="truncation-allowed">{digest}</dd>
        </div>
        <div>
          <dt>{labels.size}</dt>
          <dd>{size}</dd>
        </div>
        <div>
          <dt>{labels.mediaType}</dt>
          <dd>{mediaType}</dd>
        </div>
        <div>
          <dt>{labels.provenance}</dt>
          <dd>{provenance}</dd>
        </div>
      </dl>
      {isSafeArtifactHref(href) ? <a href={href}>{labels.link}</a> : null}
    </div>
  );
}
