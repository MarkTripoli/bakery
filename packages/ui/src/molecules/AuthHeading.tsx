import type { HTMLAttributes, ReactNode } from "react";
import { Heading } from "../atoms/Heading.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../navigation.css";

export type AuthHeadingProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    /** The `<h1>` that names the screen. */
    title: ReactNode;
    /** One sentence of supporting copy below the title. */
    description: ReactNode;
  };

/**
 * The title/description pair that opens every authentication and account
 * screen — Paper's `heading(title, description)` helper (auth.css:9
 * `.form-heading`): an 8px-gapped column of the page `<h1>` (28/36 above
 * 744px, 24/32 on phone) and a 16px muted paragraph. The heading takes
 * `tabIndex={-1}` so a route change can move focus to it, exactly as the
 * mock's `<h1 tabindex="-1">` does.
 */
export function AuthHeading(
  { description, title, ...props }: AuthHeadingProps,
) {
  return (
    <div
      className="ui-auth-heading"
      {...props}
      data-state="default"
      data-ui-component="authHeading"
      data-variant="default"
    >
      <Heading level="page" tabIndex={-1}>{title}</Heading>
      <p className="ui-auth-heading__description">{description}</p>
    </div>
  );
}
