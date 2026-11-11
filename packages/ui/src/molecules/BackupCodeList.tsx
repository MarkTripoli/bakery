import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type BackupCodeListProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    /** The one-time recovery codes, in the order the server returned them. */
    codes: readonly string[];
  };

/**
 * The recovery codes a principal saves once — Paper's `.backup-code-list`
 * (auth.css:23): a two-column grid of monospaced `<code>` elements on a
 * subtle plate, each code selectable in one gesture (`user-select: all`),
 * the type stepping down on small phones (auth.css:24).
 */
export function BackupCodeList({ codes, ...props }: BackupCodeListProps) {
  return (
    <div
      className="ui-backup-code-list"
      {...props}
      data-state="default"
      data-ui-component="backupCodeList"
      data-variant="default"
    >
      {codes.map((code) => (
        <code className="ui-backup-code-list__code" key={code}>{code}</code>
      ))}
    </div>
  );
}
