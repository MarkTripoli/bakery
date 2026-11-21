import type { JSX } from "react";
import { ForgotPasswordScreen } from "../../screens/ForgotPasswordScreen.tsx";

/** `/sign-in/forgot-password`: one state, the page as shipped today. */
export const forgotSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => <ForgotPasswordScreen onBackToSignIn={() => {}} />,
};
