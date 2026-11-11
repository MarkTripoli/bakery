import {
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../controls.css";

export type SwitchProps =
  & Omit<SemanticNativeProps<InputHTMLAttributes<HTMLInputElement>>, "type">
  & {
    children: ReactNode;
    pending?: boolean;
  };

export function Switch(
  { children, pending = false, ...unsafeInputProps }: SwitchProps,
) {
  const inputProps = withoutSemanticOwnerProps(unsafeInputProps);
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [uncontrolledChecked, setUncontrolledChecked] = useState(
    Boolean(inputProps.defaultChecked),
  );
  const isChecked = inputProps.checked === undefined
    ? uncontrolledChecked
    : inputProps.checked;
  useEffect(() => {
    const input = inputRef.current;
    if (!input || inputProps.checked !== undefined) return;
    const form = input.form;
    if (!form) return;
    let disposed = false;
    const synchronizeReset = () => {
      globalThis.setTimeout(() => {
        if (!disposed) setUncontrolledChecked(input.checked);
      });
    };
    form.addEventListener("reset", synchronizeReset);
    return () => {
      form.removeEventListener("reset", synchronizeReset);
      disposed = true;
    };
  }, [inputProps.checked]);
  const state = pending
    ? "pending"
    : inputProps.disabled
    ? "disabled"
    : focused
    ? "focus"
    : "default";
  return (
    <label
      className="ui-switch"
      data-ui-component="switch"
      data-state={state}
      data-variant={isChecked ? "on" : "off"}
    >
      <input
        {...inputProps}
        aria-busy={pending || undefined}
        onBlur={(event) => {
          inputProps.onBlur?.(event);
          setFocused(false);
        }}
        onChange={(event) => {
          inputProps.onChange?.(event);
          if (inputProps.checked === undefined) {
            setUncontrolledChecked(event.currentTarget.checked);
          }
        }}
        onFocus={(event) => {
          inputProps.onFocus?.(event);
          setFocused(true);
        }}
        ref={inputRef}
        role="switch"
        type="checkbox"
      />
      {children}
    </label>
  );
}
