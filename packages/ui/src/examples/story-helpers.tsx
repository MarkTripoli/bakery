import { type KeyboardEvent, useId, useState } from "react";
import * as UI from "@bakery/ui";

export function TabExample({
  disabled = false,
  label,
  state,
  variant,
}: {
  disabled?: boolean;
  label: string;
  state?: "default" | "selected" | "focus" | "disabled";
  variant?: "route" | "view";
}) {
  const [selected, setSelected] = useState("overview");
  return (
    <UI.Tabs
      aria-label={label}
      selectedId={selected}
      onSelect={setSelected}
      state={state}
      variant={variant}
      tabs={[
        {
          id: "overview",
          label: "Overview",
          content: (
            <UI.Text>Everything you need to start the next task.</UI.Text>
          ),
        },
        {
          id: "activity",
          label: "Activity",
          disabled,
          content: <UI.Text>Alex updated this task a moment ago.</UI.Text>,
        },
        {
          id: "settings",
          label: "Settings",
          content: <UI.Text>Update this task view.</UI.Text>,
        },
      ]}
    />
  );
}

type DialogExampleProps =
  | {
    kind: "dialog";
    state?: "closed" | "open" | "submitting" | "error";
    variant?: "form" | "information";
  }
  | {
    kind: "sheet";
    state?: "closed" | "open" | "submitting" | "error";
    variant?: "bottom" | "side";
  }
  | {
    kind: "alert";
    state?: "closed" | "open" | "confirming" | "error";
    variant?: "destructive" | "security";
  };

export function DialogExample(props: DialogExampleProps) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState("");
  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    setResult(`${props.kind}:${event.key}`);
  };
  const requestedState = props.state;
  const stateCopy = requestedState === "submitting" ||
      requestedState === "confirming"
    ? "The requested action is in progress."
    : requestedState === "error"
    ? "The requested action could not be completed."
    : "This is a local preview. No project data will change.";
  const content = (
    <>
      <UI.Text>{stateCopy}</UI.Text>
      <form method="dialog">
        <UI.Button type="submit">Close preview</UI.Button>
      </form>
    </>
  );
  const triggerLabel = requestedState
    ? `Show ${requestedState} ${props.kind}`
    : `Open ${props.kind === "alert" ? "confirmation" : props.kind}`;
  return (
    <UI.Stack>
      <UI.Button
        aria-expanded={open}
        data-semantic-absent-state={requestedState === undefined
          ? "closed"
          : undefined}
        data-semantic-state-trigger={requestedState &&
            requestedState !== "closed"
          ? requestedState
          : undefined}
        data-testid={requestedState === undefined
          ? `native-${props.kind}-trigger`
          : undefined}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </UI.Button>
      {props.kind === "dialog"
        ? (
          <UI.Dialog
            aria-label="Task preview"
            data-testid={requestedState === undefined
              ? "native-dialog"
              : undefined}
            title="Task preview"
            open={open}
            onOpenChange={setOpen}
            onKeyDown={handleKeyDown}
            state={open ? props.state ?? "submitting" : "closed"}
            variant={props.variant}
          >
            {content}
          </UI.Dialog>
        )
        : props.kind === "sheet"
        ? (
          <UI.Sheet
            aria-label="Task details"
            data-testid={requestedState === undefined
              ? "native-sheet"
              : undefined}
            title="Task details"
            open={open}
            onOpenChange={setOpen}
            onKeyDown={handleKeyDown}
            state={open ? props.state ?? "error" : "closed"}
            variant={props.variant}
          >
            {content}
          </UI.Sheet>
        )
        : (
          <UI.AlertDialog
            aria-label="Archive task?"
            data-testid={requestedState === undefined
              ? "native-alert"
              : undefined}
            title="Archive task?"
            open={open}
            onOpenChange={setOpen}
            onKeyDown={handleKeyDown}
            state={open ? props.state ?? "confirming" : "closed"}
            variant={props.variant}
            cancelAction={
              <UI.Button
                variant="secondary"
                onClick={() => setOpen(false)}
              >
                Cancel
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                variant="destructive"
                onClick={() => {
                  setResult("Preview task archived.");
                  setOpen(false);
                }}
              >
                Archive
              </UI.Button>
            }
          >
            You can restore this task later.
          </UI.AlertDialog>
        )}
      {result && <UI.Text role="status">{result}</UI.Text>}
    </UI.Stack>
  );
}

export function AuthExample({ invitation = false }: { invitation?: boolean }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <form
      className="gallery-form"
      data-state="default"
      data-variant="desktop"
      data-ui-component={invitation ? "authInvitation" : "authSignIn"}
      onSubmit={(event) => {
        event.preventDefault();
        setSent(true);
      }}
    >
      <UI.LogoMark variant="wordmark" />
      <UI.Heading level="subsection">
        {invitation ? "Join the Bakery workspace" : "Welcome back"}
      </UI.Heading>
      <UI.Text>
        {invitation
          ? "Alex invited you to collaborate on Bakery."
          : "Sign in to pick up where you left off."}
      </UI.Text>
      <UI.Field
        htmlFor={id}
        label="Work email"
        hint="Demo only. No email is sent."
      >
        <UI.TextInput
          autoComplete="email"
          disabled={false}
          id={id}
          invalid={false}
          name="email"
          onChange={setEmail}
          readOnly={false}
          required
          type="email"
          value={email}
        />
      </UI.Field>
      <UI.Button type="submit">
        {invitation ? "Accept invitation" : "Continue with email"}
      </UI.Button>
      {sent && (
        <UI.InlineNotice role="status">
          {invitation
            ? "Invitation accepted in this preview."
            : "Sign-in preview submitted."}
        </UI.InlineNotice>
      )}
    </form>
  );
}

export function WorkExample() {
  const [sort, setSort] = useState<"ascending" | "descending">("ascending");
  const rows = [{
    id: "184",
    title: "Build the component library",
    owner: "Alex",
    status: "Running",
  }, { id: "185", title: "Review navigation", owner: "Sam", status: "Ready" }];
  const ordered = sort === "ascending" ? rows : [...rows].reverse();
  return (
    <div
      data-state="reviewed"
      data-ui-component="workQueue"
      data-variant="desktop"
    >
      <UI.Stack>
        <UI.Text>Assigned to you</UI.Text>
        <UI.DataTable
          caption="Work queue"
          getRowKey={(row) => row.id}
          rows={ordered}
          sort={{ id: "title", direction: sort }}
          onSort={() =>
            setSort(sort === "ascending" ? "descending" : "ascending")}
          columns={[
            {
              id: "title",
              header: "Task",
              sortable: true,
              cell: (row) => row.title,
            },
            { id: "owner", header: "Owner", cell: (row) => row.owner },
            {
              id: "status",
              header: "Status",
              cell: (row) => (
                <UI.StatusBadge status="active">{row.status}</UI.StatusBadge>
              ),
            },
          ]}
        />
      </UI.Stack>
    </div>
  );
}

export const navigation = [
  { id: "gallery", label: "Components", href: "#components" },
  { id: "examples", label: "Page examples", href: "#page.workQueue" },
];

export const sections = [
  { id: "atoms", label: "Atoms", href: "#ui.text" },
  { id: "molecules", label: "Molecules", href: "#ui.menu" },
  { id: "organisms", label: "Organisms", href: "#ui.applicationRail" },
  { id: "templates", label: "Templates", href: "#template.appShell" },
  { id: "pages", label: "Pages", href: "#page.authSignIn" },
];
