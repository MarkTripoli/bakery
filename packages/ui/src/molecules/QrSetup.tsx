import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type QrSetupProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    /** The `<UI.QrCode />` to scan. */
    code: ReactNode;
    /** The manual-entry column beside it (heading, hint, setup key, action). */
    children: ReactNode;
  };

/**
 * The enrolment row Paper calls `.qr-setup` (auth.css:22): the QR code and a
 * 12px-gapped manual-entry column side by side, the column wrapping under
 * the code on small phones.
 */
export function QrSetup({ children, code, ...props }: QrSetupProps) {
  return (
    <div
      className="ui-qr-setup"
      {...props}
      data-state="default"
      data-ui-component="qrSetup"
      data-variant="default"
    >
      {code}
      <div className="ui-qr-setup__manual">{children}</div>
    </div>
  );
}
