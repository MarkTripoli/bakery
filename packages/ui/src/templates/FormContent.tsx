import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../navigation.css";

export type FormContentProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    children: ReactNode;
  };

/**
 * The narrower column the confirm-style settings pages (revoke sessions,
 * authenticator setup, backup codes) put a form in — Paper's
 * `.settings-content>.form-content` (auth.css:10): a 520px measure with the
 * same 28px/24px column gap as `SettingsContent`. Nest it anywhere inside a
 * `SettingsContent`; the heading and rows around it stay full width.
 */
export function FormContent({ children, ...props }: FormContentProps) {
  return (
    <div
      className="ui-form-content"
      {...props}
      data-state="default"
      data-ui-component="formContent"
      data-variant="default"
    >
      {children}
    </div>
  );
}
