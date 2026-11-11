import type { HTMLAttributes, ReactNode } from "react";
import { Heading } from "../atoms/Heading.tsx";
import { Text } from "../atoms/Text.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./integration-app-registration.css";

export type IntegrationAppRegistrationProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "title">>
  & {
    title: string;
    description: string;
    /** What the installation shows now; the caller owns the data behind it. */
    state: "unregistered" | "registered" | "loading" | "error" | "forbidden";
    /** Status and outcome banners, rendered between the heading and the body. */
    notices?: ReactNode;
    /** The registration body: the create action or the registered App details. */
    children?: ReactNode;
  };

/**
 * The installation's GitHub App registration column: page heading, status
 * banners and the body that shows the create action or the registered App.
 * The controller supplies translated copy and decides who may see it.
 */
export function IntegrationAppRegistration(
  { title, description, state, notices, children, ...props }:
    IntegrationAppRegistrationProps,
) {
  return (
    <div
      className="ui-integration-app-registration"
      {...props}
      aria-busy={state === "loading" || undefined}
      data-state={state}
      data-ui-component="integrationAppRegistration"
      data-variant="github"
    >
      <div className="ui-integration-app-registration__heading">
        <Heading level="page">{title}</Heading>
        <Text variant="muted">{description}</Text>
      </div>
      {notices}
      {children}
    </div>
  );
}
