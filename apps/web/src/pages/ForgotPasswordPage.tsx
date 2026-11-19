import { useNavigate } from "@tanstack/react-router";
import { SIGN_IN_PATH } from "../app/auth-required.tsx";
import { ForgotPasswordScreen } from "../screens/ForgotPasswordScreen.tsx";

/** `/sign-in/forgot-password`: what can be done today when a password is forgotten. */
export function ForgotPasswordPage() {
  const navigate = useNavigate();
  return (
    <ForgotPasswordScreen
      onBackToSignIn={() => void navigate({ to: SIGN_IN_PATH })}
    />
  );
}
