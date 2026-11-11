import type { JSX } from "react";
import { RevokeSessionsScreen } from "../../screens/RevokeSessionsScreen.tsx";

const callbacks = {
  onCancel: () => {},
  onConfirm: () => {},
  onRetry: () => {},
  onReturn: () => {},
} as const;

export const revokeSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => (
    <RevokeSessionsScreen
      {...callbacks}
      count={2}
      failed={false}
      pending={false}
      state="confirm"
    />
  ),
  success: () => (
    <RevokeSessionsScreen
      {...callbacks}
      count={2}
      failed={false}
      pending={false}
      state="success"
    />
  ),
  failed: () => (
    <RevokeSessionsScreen
      {...callbacks}
      count={2}
      failed
      pending={false}
      state="confirm"
    />
  ),
};
