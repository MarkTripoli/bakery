import { type FormHTMLAttributes, useEffect, useRef } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../navigation.css";

export type HandoffFormProps =
  & SemanticNativeProps<
    Omit<
      FormHTMLAttributes<HTMLFormElement>,
      "action" | "children" | "hidden" | "method"
    >
  >
  & {
    /** Absolute URL the browser navigates to with the POST. */
    action: string;
    /** Hidden fields posted as-is; values are never rendered as text. */
    fields: Readonly<Record<string, string>>;
    /** Posts once, as soon as the form mounts; the default waits for a call to `submit`. */
    autoSubmit?: boolean;
  };

/**
 * A visually hidden form that hands the browser to another site with a POST,
 * such as GitHub's App manifest page. The caller announces the hand-off in
 * visible, translated copy.
 */
export function HandoffForm(
  { action, fields, autoSubmit = false, ...props }: HandoffFormProps,
) {
  const form = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);
  useEffect(() => {
    if (!autoSubmit || submitted.current) return;
    submitted.current = true;
    form.current?.submit();
  }, [autoSubmit]);
  return (
    <form
      className="bakery-visually-hidden"
      {...props}
      action={action}
      data-state="default"
      data-ui-component="handoffForm"
      data-variant="default"
      method="post"
      ref={form}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
    </form>
  );
}
