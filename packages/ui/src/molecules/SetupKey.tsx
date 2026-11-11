import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type SetupKeyProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    /** The shared secret, already grouped for reading. */
    children: string;
  };

/**
 * A secret to type by hand — Paper's `.code.setup-key` (auth.css:10, :22):
 * the boxed monospaced plate holding a TOTP setup key, selectable in one
 * gesture. Distinct from `DataText` (inline identifiers inside prose) and
 * `CodeBlock` (multi-line source).
 */
export function SetupKey({ children, ...props }: SetupKeyProps) {
  return (
    <div
      className="ui-setup-key"
      {...props}
      data-state="default"
      data-ui-component="setupKey"
      data-variant="default"
    >
      {children}
    </div>
  );
}
