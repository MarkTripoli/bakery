import * as UI from "@bakery/ui";
import { useState } from "react";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ACTION_LINES } from "./workflow-state.ts";

/**
 * The panel beside the diagram (#67, slice 1): what the person selected, and
 * the actions the design puts in the panel footer. Three things can be
 * selected, and each gets one treatment (design-ux's ruling, comment
 * 6917906748):
 *
 * - the start card, which says how a workflow starts and offers nothing;
 * - a part written in code (a group, or a step only changeable in code), which
 *   says so and offers "View as code" and no Move or Remove;
 * - a step, with its name as the step type's own name (the definition has no
 *   place to store a person's name yet) and move up, move down and remove.
 *
 * The reducer behind the actions is the same one the list editor used, so undo
 * and redo still decide what actually happens.
 */

/**
 * One skill a step names, as the reader may see it (#431, design-ux). Someone
 * else's private skill is a placeholder: its name, its owner and its version,
 * never a link, a file or a description.
 */
export type StepSkillRow = {
  readonly key: string;
  readonly name: string | null;
  readonly revision: number | null;
  readonly scope: "global" | "organization" | "personal" | null;
  readonly owner: string | null;
  /** The reader owns this private skill. */
  readonly mine: boolean;
  /** Whether the skill can be used at this step now, or why it cannot. */
  readonly status: "available" | "stopped" | "unavailable" | "missing";
  /** Takes the skill off the step; absent when the page cannot edit or the row is a slot. */
  readonly onRemove?: () => void;
};

/** One skill the picker offers: the active version people attach (#431). */
export type SkillChoice = {
  /** The skill's active version id: what the step names. */
  readonly value: string;
  readonly name: string;
  readonly slug: string;
  readonly revision: number;
  /** Your organization's skills come first; the caller's own private ones after. */
  readonly group: "organization" | "private";
};

/** What the picker shows: while it reads, when it failed, or the skills to choose from. */
export type StepAttach = {
  readonly state: "loading" | "failed" | "ready";
  readonly choices: readonly SkillChoice[];
  /** How many skills fit this step before the attached ones are taken out of the choices. */
  readonly offered: number;
  readonly onRetry: () => void;
  readonly onChoose: (value: string) => void;
};

/** What the Skills list of a step shows: not at all, while it reads, when it failed, or the rows. */
export type StepSkills =
  | { readonly kind: "hidden" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly onRetry: () => void }
  | { readonly kind: "ready"; readonly rows: readonly StepSkillRow[] };

/** What the panel is showing. */
export type PanelTarget =
  | { readonly kind: "start" }
  | {
    readonly kind: "codeOnly";
    readonly name: string;
    /** The problem's sentence, shown above the code-only sentence. */
    readonly problem: string | undefined;
  }
  | {
    readonly kind: "step";
    /** The card's name: the step type's own name, or "Unreadable step". */
    readonly name: string;
    /** Whether this page may delete the step, which is every editable page. */
    readonly deletable: boolean;
    readonly uses: string;
    /** What the definition states, when the step could not be drawn as an action. */
    readonly code: string | undefined;
    readonly problem: string | undefined;
    /** The skills the step names (#431). */
    readonly skills: StepSkills;
    /** The picker that attaches a skill; null when the page cannot edit. */
    readonly attach: StepAttach | null;
    readonly canMoveUp: boolean;
    readonly canMoveDown: boolean;
    readonly disabled: boolean;
    readonly onMoveUp: () => void;
    readonly onMoveDown: () => void;
    readonly onRemove: () => void;
  };

export function StepPanel(
  { target, onViewAsCode }: {
    readonly target: PanelTarget;
    readonly onViewAsCode: () => void;
  },
) {
  const { translate } = useI18n();
  const label = translate("library.editor.panel.label" as never);

  if (target.kind === "start") {
    return (
      <UI.InspectorPanel
        id="editor-step-panel"
        label={label}
        variant="column"
        header={
          <UI.Text variant="strong">
            {translate("library.editor.howItStarts" as never)}
          </UI.Text>
        }
      >
        <UI.Text>
          {translate("library.editor.startsByHand" as never)}
        </UI.Text>
      </UI.InspectorPanel>
    );
  }

  if (target.kind === "codeOnly") {
    return (
      <UI.InspectorPanel
        id="editor-step-panel"
        label={label}
        variant="column"
        header={<UI.Text variant="strong">{target.name}</UI.Text>}
        footer={
          <UI.Button variant="secondary" onClick={onViewAsCode}>
            {translate("library.editor.viewAsCode" as never)}
          </UI.Button>
        }
      >
        <UI.Stack gap="compact">
          {target.problem === undefined
            ? null
            : (
              <UI.InlineNotice role="status" tone="error">
                {target.problem}
              </UI.InlineNotice>
            )}
          <UI.Text>
            {translate("library.editor.panel.codeOnly" as never)}
          </UI.Text>
        </UI.Stack>
      </UI.InspectorPanel>
    );
  }

  const lineKey = ACTION_LINES[target.uses];
  const line = lineKey === undefined ? undefined : translate(lineKey as never);

  return (
    <UI.InspectorPanel
      id="editor-step-panel"
      label={label}
      variant="column"
      header={<UI.Text variant="strong">{target.name}</UI.Text>}
      footer={
        <UI.Inline gap="compact">
          <UI.Button
            variant="secondary"
            disabled={target.disabled || !target.canMoveUp}
            onClick={target.onMoveUp}
          >
            {translate("library.editor.panel.moveUp" as never)}
          </UI.Button>
          <UI.Button
            variant="secondary"
            disabled={target.disabled || !target.canMoveDown}
            onClick={target.onMoveDown}
          >
            {translate("library.editor.panel.moveDown" as never)}
          </UI.Button>
          <UI.Button
            variant="destructive"
            // A step Bakery cannot read is exactly the one a person must be
            // able to delete, so only a read-only page disables this button
            // (#67 UX ruling 6932934119 fix 6).
            disabled={!target.deletable}
            onClick={target.onRemove}
          >
            {translate("library.editor.panel.remove" as never)}
          </UI.Button>
        </UI.Inline>
      }
    >
      <UI.Stack gap="compact">
        {line === undefined ? null : <UI.Text>{line}</UI.Text>}
        {target.problem === undefined
          ? null
          : (
            <UI.InlineNotice role="status" tone="error">
              {target.problem}
            </UI.InlineNotice>
          )}
        {target.code === undefined ? null : (
          <UI.Text variant="caption">
            {translate("library.editor.card.writtenInCode" as never, {
              code: target.code,
            })}
          </UI.Text>
        )}
        {target.skills.kind === "hidden"
          ? null
          : <Skills attach={target.attach} skills={target.skills} />}
      </UI.Stack>
    </UI.InspectorPanel>
  );
}

/**
 * The Skills list of a step: the skills it names, in the order the server gives
 * them. A private skill wears one small word, Private; someone else's is plain
 * text on its row, with who let the workflow use it.
 */
function Skills(
  { skills, attach }: {
    readonly skills: Exclude<StepSkills, { readonly kind: "hidden" }>;
    readonly attach: StepAttach | null;
  },
) {
  const { translate } = useI18n();
  const t = (key: string, values?: Record<string, string | number>) =>
    translate(
      `library.workflow.editor.skills.${key}` as never,
      values as never,
    );
  const nothingOnOffer = attach !== null && attach.state === "ready" &&
    attach.offered === 0;
  return (
    <UI.Stack data-testid="step-skills" gap="compact">
      <UI.Inline gap="compact">
        <UI.Text variant="strong">{t("title")}</UI.Text>
        <UI.HelpTip label={t("helpLabel")}>{t("help")}</UI.HelpTip>
      </UI.Inline>
      {skills.kind === "loading"
        ? (
          <div aria-busy="true">
            <UI.Skeleton shape="row" />
          </div>
        )
        : skills.kind === "failed"
        ? (
          <UI.InlineNotice
            action={
              <UI.Button onClick={skills.onRetry} variant="secondary">
                {translate("core.actions.retry" as never)}
              </UI.Button>
            }
            role="status"
            tone="error"
          >
            {t("failed")}
          </UI.InlineNotice>
        )
        : skills.rows.length === 0
        // With nothing on offer the picker's own line says so: one empty line, not two.
        ? (nothingOnOffer
          ? null
          : <UI.Text variant="muted">{t("empty")}</UI.Text>)
        : (
          <UI.Stack gap="comfortable" role="list">
            {skills.rows.map((row) => (
              <SkillRow
                key={row.key}
                row={row}
                t={t}
              />
            ))}
          </UI.Stack>
        )}
      {attach === null || skills.kind !== "ready" ? null : (
        <AttachSkill
          attach={attach}
          hasRows={skills.rows.length > 0}
          t={t}
        />
      )}
    </UI.Stack>
  );
}

type Say = (key: string, values?: Record<string, string | number>) => string;

/**
 * The picker that attaches a skill (#431, design-ux): the organization's skills
 * first, then the caller's own private ones, with the group line that says
 * attaching one shares its use, not its files. Two skills of one name in one
 * group carry their slug so they can be told apart.
 */
function AttachSkill(
  { attach, hasRows, t }: {
    readonly attach: StepAttach;
    /** Whether the step already shows a skill row. */
    readonly hasRows: boolean;
    readonly t: Say;
  },
) {
  const { translate } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  if (attach.state === "failed") {
    return (
      <UI.InlineNotice
        action={
          <UI.Button onClick={attach.onRetry} variant="secondary">
            {translate("core.actions.retry" as never)}
          </UI.Button>
        }
        role="status"
        tone="error"
      >
        {t("picker.failed")}
      </UI.InlineNotice>
    );
  }
  if (attach.state === "ready" && attach.choices.length === 0) {
    // Nothing fits and nothing is shown: say so once. Otherwise the step already shows
    // what it has, and one short line says nothing more can be attached.
    const none = attach.offered === 0 && !hasRows;
    return (
      <UI.Text variant={none ? "muted" : "caption"}>
        {t(none ? "picker.empty" : "picker.allAttached")}
      </UI.Text>
    );
  }
  if (attach.state === "loading") {
    return (
      <UI.Button aria-busy disabled variant="secondary">
        {t("picker.placeholder")}
      </UI.Button>
    );
  }
  const needle = query.trim().toLocaleLowerCase();
  const matches = (choice: SkillChoice) =>
    needle === "" ||
    `${choice.name} ${choice.slug}`.toLocaleLowerCase().includes(needle);
  const optionsOf = (group: SkillChoice["group"]) => {
    const inGroup = attach.choices.filter((choice) => choice.group === group);
    return inGroup.filter(matches).map((choice) => {
      const same = inGroup.filter((other) => other.name === choice.name).length;
      return (
        <UI.Button
          data-pick-skill={choice.value}
          key={choice.value}
          onClick={() => {
            setOpen(false);
            setQuery("");
            attach.onChoose(choice.value);
          }}
          variant="quiet"
        >
          <span>
            {choice.name}
            {t("picker.versionTail", { version: choice.revision })}
            {same > 1 ? t("picker.slugTail", { slug: choice.slug }) : null}
          </span>
        </UI.Button>
      );
    });
  };
  const organization = optionsOf("organization");
  const personal = optionsOf("private");
  return (
    <UI.Popover
      label={t("picker.label")}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      open={open}
      trigger={t("picker.placeholder")}
      triggerAppearance="toolbar"
      variant="interactive"
    >
      <UI.Stack data-testid="skill-picker" gap="compact">
        <UI.SearchField
          aria-label={t("picker.find")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("picker.find")}
          value={query}
        />
        <UI.Stack data-picker-list="true" gap="compact">
          {organization.length === 0 && personal.length === 0
            ? (
              <UI.Text variant="muted">
                {t("picker.noMatch", { text: query })}
              </UI.Text>
            )
            : null}
          {organization.length === 0 ? null : (
            <>
              <UI.Text variant="strong">
                {t("picker.groupOrganization")}
              </UI.Text>
              {organization}
            </>
          )}
          {personal.length === 0 ? null : (
            <>
              <UI.Text variant="strong">{t("picker.groupPrivate")}</UI.Text>
              {personal}
            </>
          )}
        </UI.Stack>
      </UI.Stack>
    </UI.Popover>
  );
}

function SkillRow(
  { row, t }: {
    readonly row: StepSkillRow;
    readonly t: (
      key: string,
      values?: Record<string, string | number>,
    ) => string;
  },
) {
  const version = row.revision ?? 0;
  const name = row.name ?? "";
  // The owner may be unknown (they left): the lines then say "someone else's".
  const owner = (row.owner ?? "").trim();
  // A skill that cannot be used says what happened; what to do about it comes with the controls.
  if (row.status !== "available") {
    return (
      <UI.Stack data-skill-status={row.status} gap="tight" role="listitem">
        <UI.Inline gap="compact">
          <UI.Text variant="strong">
            {row.name === null
              ? t(`slot.${row.status}.titleUnnamed`)
              : t(`slot.${row.status}.title`, { name })}
          </UI.Text>
          <UI.Badge tone="warning">{t("slot.badge")}</UI.Badge>
        </UI.Inline>
        <UI.Text variant="muted">
          {row.status === "missing" && row.name === null
            ? t("slot.missing.bodyUnnamed")
            : t(`slot.${row.status}.body`, { name })}
        </UI.Text>
      </UI.Stack>
    );
  }
  const personal = row.scope === "personal";
  return (
    <UI.Stack gap="tight" role="listitem">
      <UI.Inline data-hung-tip gap="compact">
        <UI.Text variant="strong">{name}</UI.Text>
        {personal ? <UI.Badge tone="neutral">{t("private")}</UI.Badge> : null}
        {personal && !row.mine
          ? (
            <UI.HelpTip label={t("privateHelpLabel", { name })}>
              {owner === ""
                ? t("privateHelpUnnamed")
                : t("privateHelp", { owner })}
            </UI.HelpTip>
          )
          : null}
      </UI.Inline>
      <UI.Text variant="muted">
        {personal
          ? row.mine
            ? t("row.mine", { version })
            : owner === ""
            ? t("row.theirsUnnamed", { version })
            : t("row.theirs", { version, owner })
          : t(row.scope === "global" ? "row.global" : "row.organization", {
            version,
          })}
      </UI.Text>
      {row.onRemove === undefined ? null : (
        <UI.Inline>
          <UI.Button
            aria-label={t("remove.label", { name })}
            onClick={row.onRemove}
            variant="text"
          >
            {t("remove.action")}
          </UI.Button>
        </UI.Inline>
      )}
    </UI.Stack>
  );
}
