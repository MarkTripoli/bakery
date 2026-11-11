import type { ReactNode } from "react";
import { Sheet } from "../molecules/Sheet.tsx";
import "../artifacts.css";

export type CommentSheetProps = {
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly dismissLabel: string;
  readonly children: ReactNode;
};
export function CommentSheet({ children, ...props }: CommentSheetProps) {
  return (
    <Sheet {...props}>
      <div
        className="ui-comment-sheet"
        hidden={!props.open}
        data-ui-component="commentSheet"
        data-variant="bottom"
        data-state={props.open ? "open" : "closed"}
      >
        {children}
      </div>
    </Sheet>
  );
}
