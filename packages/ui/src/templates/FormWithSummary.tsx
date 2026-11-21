import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../navigation.css";

export type FormWithSummaryProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "children">>
  & {
    /** The form's sections: fields, choices and the lines that explain them. */
    children: ReactNode;
    /** What the form will do, kept in view beside it: a plain summary and notes. */
    aside: ReactNode;
    /** The buttons that end the form: the way out first, the main step last. */
    actions: ReactNode;
  };

/**
 * A form page with a plain summary beside it (the batch start page, #58).
 *
 * From 1280px (the shell's desktop width) the form is at most 620px wide and the summary is a 300px column
 * at its side, level with the top of the form; the buttons sit under the form,
 * at its end. Below that the summary comes between the form and the buttons, so
 * it is read before the step is taken. On a phone the buttons stack with the
 * main step first. In one column the template is no wider than the form is
 * beside its summary, so the buttons end at the form's edge.
 */
export function FormWithSummary(
  { children, aside, actions, ...props }: FormWithSummaryProps,
) {
  return (
    <div
      className="ui-form-with-summary"
      {...props}
      data-state="default"
      data-ui-component="formWithSummary"
      data-variant="default"
    >
      <div className="ui-form-with-summary__form">{children}</div>
      <aside className="ui-form-with-summary__aside">{aside}</aside>
      <div className="ui-form-with-summary__actions">{actions}</div>
    </div>
  );
}
