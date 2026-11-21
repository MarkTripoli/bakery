import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

/**
 * The Slack row in **Linked accounts**, and what a person may do from it.
 *
 * A person links their own Slack account once so that approving or messaging
 * from Slack is recorded under their name. The row is deliberately the shape of
 * the Password row on this page: one line of state and one action, because
 * linking is a fact about the account rather than a settings form.
 *
 * A link belongs to the organization being viewed, so the row names the Slack
 * workspace where the installation gives one, and every state is a plain value
 * the caller derives: this file decides nothing about who may link.
 */
export type LinkedSlackState =
  | { readonly kind: "not-installed"; readonly canConnect: boolean }
  | { readonly kind: "not-linked" }
  | { readonly kind: "waiting" }
  | {
    readonly kind: "linked";
    /** The workspace's name, when the installation knows it. */
    readonly workspace?: string;
    readonly linkedAt: Date;
    /** Present when no link is left to remove (for example, already gone). */
    readonly removable?: boolean;
  }
  | { readonly kind: "removed"; readonly removedAt: Date }
  | { readonly kind: "loading" }
  | { readonly kind: "load-failed" };

export type LinkedSlackBanner =
  | "linked"
  | "unchanged"
  | "provider_denied"
  | "link_refused"
  | "exchange_failed"
  | "expired"
  | "wrong_workspace"
  | "unlinked"
  | "unlink_failed";

export type LinkedSlackRowProps = {
  readonly state: LinkedSlackState;
  /** The organization whose link this is, by name. */
  readonly organizationName: string;
  /** The workspace's name, for the outcomes that would otherwise say "it". */
  readonly workspace?: string;
  readonly banner?: LinkedSlackBanner;
  /** True while `Link Slack` has been pressed and Slack has not answered. */
  readonly linking?: boolean;
  readonly onLink: () => void;
  readonly onUnlink: () => void;
  readonly onTryAgain: () => void;
};

/**
 * Every outcome a Slack round trip can produce, as a banner. The copy never
 * carries a code, a token or anything Slack returned: a person reads what
 * happened and what is true now.
 */
function bannerCopy(
  banner: LinkedSlackBanner,
  translate: ReturnType<typeof useI18n>["translate"],
  organizationName: string,
  workspace: string | undefined,
): { tone: "success" | "information" | "error"; text: string } {
  switch (banner) {
    case "linked":
      return {
        tone: "success",
        text: translate("settings.security.linked.slack.result.linked"),
      };
    case "unchanged":
      return {
        tone: "information",
        text: translate("settings.security.linked.slack.result.unchanged"),
      };
    case "provider_denied":
      return {
        tone: "information",
        text: translate("settings.security.linked.slack.result.providerDenied"),
      };
    case "link_refused":
      return {
        tone: "error",
        text: translate("settings.security.linked.slack.result.linkRefused", {
          organization: organizationName,
        }),
      };
    case "exchange_failed":
      return {
        tone: "error",
        text: translate(
          "settings.security.linked.slack.result.couldNotConfirm",
        ),
      };
    case "expired":
      return {
        tone: "information",
        text: translate("settings.security.linked.slack.result.expired"),
      };
    case "wrong_workspace":
      // Checked before the token itself, so it always gets its own sentence -
      // and names the workspace when the installation knows it.
      return {
        tone: "error",
        text: workspace === undefined
          ? translate(
            "settings.security.linked.slack.result.wrongWorkspaceNoName",
            { organization: organizationName },
          )
          : translate(
            "settings.security.linked.slack.result.wrongWorkspace",
            { workspace },
          ),
      };
    case "unlinked":
      return {
        tone: "success",
        text: translate("settings.security.linked.slack.unlinked"),
      };
    case "unlink_failed":
      return {
        tone: "error",
        text: translate("settings.security.linked.slack.unlinkFailed"),
      };
  }
}

/** The line under "Slack", by state. */
function rowLine(
  state: LinkedSlackState,
  translate: ReturnType<typeof useI18n>["translate"],
  organizationName: string,
  date: (value: Date) => string,
): string {
  switch (state.kind) {
    case "not-installed":
      return translate(
        "settings.security.linked.slack.notInstalled",
        { organization: organizationName },
      );
    case "not-linked":
      return translate("settings.security.linked.slack.notLinked");
    case "waiting":
      return translate("settings.security.linked.slack.waiting");
    case "linked":
      return state.workspace === undefined
        ? translate("settings.security.linked.slack.linkedNoWorkspace", {
          date: date(state.linkedAt),
        })
        : translate("settings.security.linked.slack.linked", {
          workspace: state.workspace,
          date: date(state.linkedAt),
        });
    case "removed":
      return translate("settings.security.linked.slack.removed", {
        date: date(state.removedAt),
      });
    case "loading":
      return "";
    case "load-failed":
      return translate("settings.security.linked.slack.loadFailed");
  }
}

/**
 * The row's one action. A state with nothing a person can do has none, which is
 * the honest answer for "waiting" and for an organization with no Slack.
 */
function rowAction(
  state: LinkedSlackState,
  translate: ReturnType<typeof useI18n>["translate"],
  props: LinkedSlackRowProps,
): React.ReactNode {
  const link = (
    <UI.Button
      disabled={props.linking === true}
      onClick={props.onLink}
      variant="primary"
    >
      {translate("settings.security.linked.slack.link")}
    </UI.Button>
  );
  switch (state.kind) {
    case "not-installed":
      // Only an installation administrator can connect Slack, so only they get
      // a way there; everyone else is told who acts.
      return state.canConnect
        ? (
          <UI.Link href="/settings/installation/integrations">
            {translate("settings.security.linked.slack.connectSlack")}
          </UI.Link>
        )
        : null;
    case "not-linked":
    case "removed":
      return link;
    case "waiting":
      return (
        <UI.Button busy disabled variant="primary">
          {translate("settings.security.linked.slack.link")}
        </UI.Button>
      );
    case "linked":
      return state.removable === false
        ? null
        : (
          <UI.Button onClick={props.onUnlink} variant="secondary">
            {translate("settings.security.linked.slack.unlink")}
          </UI.Button>
        );
    case "load-failed":
      return (
        <UI.Button onClick={props.onTryAgain} variant="secondary">
          {translate("settings.security.linked.slack.tryAgain")}
        </UI.Button>
      );
    case "loading":
      return null;
  }
}

export function LinkedSlackRow(props: LinkedSlackRowProps) {
  const { translate } = useI18n();
  const date = (value: Date) => value.toISOString().slice(0, 10);
  const banner = props.banner === undefined ? null : bannerCopy(
    props.banner,
    translate,
    props.organizationName,
    props.workspace,
  );
  return (
    <UI.SettingsSection
      title={translate("settings.security.linked.heading")}
      variant="stack"
    >
      <UI.Text>{translate("settings.security.linked.description")}</UI.Text>
      {banner === null
        ? null
        : <UI.AlertBanner tone={banner.tone}>{banner.text}</UI.AlertBanner>}
      <div id="slack">
        <UI.DescriptionItem
          action={rowAction(props.state, translate, props)}
          description={props.state.kind === "loading"
            ? translate("settings.security.linked.slack.title")
            : rowLine(
              props.state,
              translate,
              props.organizationName,
              date,
            )}
          icon={<UI.IconGlyph name="chat" size="large" />}
          title={translate("settings.security.linked.slack.title")}
        />
      </div>
    </UI.SettingsSection>
  );
}
