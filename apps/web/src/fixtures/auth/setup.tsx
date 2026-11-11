import type { JSX } from "react";
import { SetupScreen } from "../../screens/SetupScreen.tsx";

/** Paper `setup` — `default` (bootstrap pending) and `ready` (bootstrapped). */
export const setupSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => (
    <SetupScreen onContinue={() => {}} onRetry={() => {}} state="default" />
  ),
  ready: () => (
    <SetupScreen onContinue={() => {}} onRetry={() => {}} state="ready" />
  ),
};
