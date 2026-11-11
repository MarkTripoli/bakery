# Mentions and notifications

**Proposed design · 8 September 2026.** This is a new product requirement: mentioning another user shares the chat with them and creates a notification. A global bell and a dedicated Notifications page collect mentions and task outcomes; every item opens its exact destination. The access grants, durable inbox, read state, and future push delivery described here are not implemented or present in the current structured catalogs. This chapter owns their reconciliation before implementation.

<!--
THESIS: Bring the right person to the exact conversation or result with one mention.
OWN-WORLD: Bakery's Geist, neutral light/dark surfaces, cobalt links, circular avatars,
208px application navigation, aligned list rows, and existing soft composer.
STORY: Select a person, send with a clear sharing consequence, follow the notification.
FIRST VIEWPORT: Global bell at upper right; Notifications leads with unread items,
actor, event, destination, and time. Phone keeps the same list and actions.
FORM: Extend the established application. One inbox with local filters; no new visual world.
-->

## Mention a person

Typing `@` in the composer opens the existing context picker with distinct **People** and **Integrations** groups. Search active human members of the current organization by first name, display/full name, or email. Matching is case-insensitive and Unicode-aware; first name is optional, so fall back to the saved display name. Search email text after the initial `@` as part of the same query. Do not turn an email address already being typed, a URL, code, quote, or pasted document into a mention.

Each result shows avatar, full display name, email, and **Has access** or **Gets chat access on send**. Duplicate first names remain separate results. Display only directory fields the sender may see; never search across organizations or invite an external email automatically. Disabled, removed, and pending-invitation accounts cannot receive a new chat grant. Empty, loading, no-match, and unavailable-directory states retain the draft. Search is server-side with bounded results and opaque cursor continuation.

Arrow keys navigate; Enter/Tab selects; Escape dismisses. Selection inserts a typed atomic **@Sam Lee** reference bound to the principal ID, preserving surrounding text. Integration references keep their provider icon and type. The picker has a labelled button entry through **Add context → People** as well. Native typing, IME, keyboard editing, and reference removal follow the [composer contract](chat-composer/BEHAVIOR.md).

Selecting a person does not share or notify yet. A draft with a new recipient says **Sam will get access to this chat and be notified when you send.** The visible Send action commits that intent without an extra routine confirmation. Removing the unsent mention removes the pending grant. A name change updates the display without changing the stored principal. A pasted name, quoted mention, model output, or attachment never grants access or sends a mention notification.

## Access granted on send

This extends the previous inherited-access-only rule in [Multiplayer](07-multiplayer.md). An authorized mention grants the active same-organization recipient **read and reply access to this conversation**, including its shared history, rather than changing their organization role or granting the whole repository. Mentioning someone who already has access only notifies them. The UI discloses whole-chat access before send, not access to just one message.

The default sharing authority is an organization Admin, or a Developer with current operation permission for the conversation's original repository/organization scope. A mention-only recipient does not inherit permission to share again. Resolve this through the shared operation guard, with an explicit `conversation.share` capability when custom roles land. A sender lacking sharing authority can mention existing readers; selecting someone without access explains **You cannot share this chat** and preserves the draft.

Effective chat access requires current organization membership and either the original inherited chat guard or an active direct conversation grant. The direct grant covers the transcript, conversation presence, and human replies. It does not authorize agent execution, repository browsing, task control, external actions, or independently protected artifacts. Attached conversation-owned material follows its explicitly shared chat boundary; linked repository/task artifacts and previews retain their own guards and show **Access required** when unavailable. Do not resolve protected bytes into a mention notification. A chat grant never changes immutable organization/repository ownership or widens sibling conversations.

Current grants apply to lists, search, transcript/history, subscriptions/replay, presence, attachment reads, and exports. **People in this chat → Access** shows inherited versus mention-granted access and who granted it. An authorized sharer can revoke the direct grant; inherited access must be managed at its source. Organization removal, account disablement, and revocation take effect on subsequent reads and live subscriptions, clearing protected client caches. Removing/deleting a sent mention does not silently revoke a person's access. Ordinary copied links remain navigation only.

On `messages.create`, validate the sender, each typed mention, recipient membership, and sharing authority against current server state. In one Postgres transaction: append the attributed message and mention references, upsert needed chat grants with provenance, create one inbox item per distinct non-self recipient, and commit the normal audit/idempotency receipt/outbox. An agent-request turn is admitted only through its existing execution guard. If any required grant fails, reject the whole send and retain the complete draft; never publish a mention that falsely promises access. Retrying the same send creates no duplicate message, grant, notification, or turn. Concurrent access removal is ordered with the send under the same authority/version checks.

For a future message-edit operation, saving newly added typed recipients uses the same atomic checks; unchanged recipients do not notify again. Historical imported content and bot echoes do not trigger retroactive grants. Recipient notifications say **Mark mentioned you in Repository onboarding**, with the specific message as the destination. Self-mentions remain visible references without a notification.

## Bell and Notifications page

The shared AppShell owns a **44×44px bell at the top-right of the navigation/header bar** on desktop and phone. It is global within the selected organization, independent of artifact or chat pane controls. A small unread count appears only when nonzero, capped visually at **99+**; the accessible label exposes the accurate available count. Unknown/offline count is not zero. Organization switching changes the inbox scope and clears stale results.

Desktop clicking the bell opens a compact recent-notifications popover with **View all notifications**. Phone opens the Notifications page directly. The full route is `/notifications` in the active organization context; `/notifications?item={id}` selects an inbox item. A valid typed destination opens the message, task result, question, or artifact at its exact anchor. Opening the bell or listing items does not mark the whole inbox read.

One list has **All**, **Unread**, and **Mentions** filters, chronological groups, and cursor pagination. These are local views of one section, so they use the existing tabs/filter pattern rather than a second navigation rail. Rows show actor/avatar or system icon, a concrete event, destination title, time, and unread text/dot. No summary dashboard or decorative metric cards. Keep read items available; **Mark read/unread** and **Mark all read** are explicit actions. Mark all read is bounded to the server snapshot cutoff so arrivals during the action remain unread. Cross-device read/unread mutations are serialized server-side and return a revision; clients discard older responses/events.

Selecting a row resolves and authorizes its destination, then marks the notification read once the target opens. A manually marked-read item remains read regardless of navigation. Deleted, moved, or inaccessible targets keep a safe **This item is no longer available** view with Back to notifications and Mark read. A notification ID or URL never grants access. Authentication redirects retain a validated relative return target; resolve organization context and authorization after sign-in. Return to the inbox preserves filters and scroll. Jumping to a message highlights its anchor briefly without deleting or submitting a draft.

### Initial events and recipients

| Event | Recipient rule | Destination |
| --- | --- | --- |
| Person mentioned | Each distinct validated recipient, excluding the sender | Exact conversation and message |
| Task completed | Human `tasks.created_by`; a service-created task needs an explicit authorized initiating-human reference or has no human recipient | Task result with the completed run/version |
| Task failed or needs input | The same initiating human; explicit question recipient when present | Failed run or exact open question |

Task completion comes from a committed terminal state, not assistant prose or an individual child-agent completion. A later rerun/outcome has its own event/version; do not overwrite history or claim that an old result is current. Dedupe task alerts by source transition and recipient; never notify every repository reader or every person who viewed the chat. Additional task subscriptions can be added when requested without changing the inbox model. Per-conversation message unread/read-position tracking remains separate from notification unread state.

Durable inbox creation must survive an offline browser, dispatcher restart, or duplicated source event. Mention notifications commit with the send; task notifications are an idempotent projection of the existing committed domain event/outbox. `/v1/events` invalidates the authenticated recipient's inbox/count by ID and revision; it is neither the inbox storage nor a message body broadcast. Refresh the authoritative page/count after reconnect. Notification creation means saved in the inbox, not seen by the person or delivered to their device.

## Proposed contracts to reconcile

These are planned additions, not routes or schemas that callers can use today. Reuse existing `principals`, organization membership, conversations, messages, tasks, domain events, and outbox. Keep tenant composite foreign keys and meaningful descriptions on every authored Zod parent and child.

| Record / projection | Minimum purpose and invariants |
| --- | --- |
| `message_mentions` | Organization, message, recipient principal; typed reference placement and display snapshot. One logical recipient per message, with validated principal identity independent of visible name/email. |
| `conversation_access_grants` | Organization, conversation, recipient, granting actor/message, read/reply scope, grant/revoke times and version. One effective grant per principal/conversation; immutable audit preserves repeated provenance. |
| `notifications` | Organization, recipient, stable kind, source event/message and source version, actor, typed target, safe localization arguments, created time, read time and revision. Unique recipient/source/kind dedupe key. Store codes/IDs rather than pre-rendered English or unrestricted message bodies. |
| Mention candidate DTO | Existing safe directory identity plus current chat-access/shareability state, bounded query and cursor. Never accept the preview's access claim as authority. |
| Inbox page/count DTO | Recipient-only authorized rows, unread total, cursor and snapshot cutoff/revision; redacted unavailable targets cannot expose protected titles/snippets. |

| Operation delta | Behavior |
| --- | --- |
| `conversations.mentionCandidates` | Scoped name/email directory search, existing-access and can-share projection. |
| `messages.create` extension | Typed people references; atomic message, grants, notifications, receipt and outbox under existing idempotency. |
| `conversationAccess.list` / `.revoke` | Inspect provenance and revoke a direct grant under sharing authority; does not remove inherited access. |
| `notifications.list` / `.get` / `.count` | Current recipient only; cursor filters, safe target projection, unread count and freshness. |
| `notifications.setRead` / `.markAllRead` | Idempotent recipient-only read/unread mutation and snapshot-bounded bulk read, with authoritative revision. |
| `notifications.resolveTarget` | Reauthorize stored typed target and return a validated internal route/anchor or safe unavailable state. |

All transports use the same guards and standard faults. Reconcile these additions into `data-model.json`, `api-catalog.json`, `transport-schemas.json`, generated descriptions/OpenAPI/MCP, migrations, and the backend delivery backlog as one owning implementation slice. Existing generated conversation integrity text describes the baseline until that reconciliation; it must not silently override this accepted extension. No new realtime service, generic event bus, or separate notification domain-write transport is needed.

## Push notification foundation

The durable inbox is the source of truth; later web/native push is an optional delivery channel for the same notification ID and typed destination. No OS permission prompt on first load or because someone mentions a user. Request device permission only from an explicit Enable push action in **Settings → Notifications**, using the shared Settings section navigation. The earlier notification-preference concepts remain future delivery settings, distinct from the new Notifications inbox.

Before push implementation, add per-principal/device subscriptions, per-category channel preferences, and a delivery ledger keyed by notification/device/channel. Recheck recipient access before delivery; use a generic lock-screen summary by default and fetch content after authentication. Logout, permission revocation, expired subscriptions, and device ownership changes disable delivery. Bounded retries cannot create duplicate inbox items. Provider acceptance is not proof of device display or a human read; multi-device read state stays in the inbox. A push tap resolves the same target after cold start/sign-in, including offline, deleted, and revoked targets. Push provider/SDK selection and channel rollout are deferred.

## Design and acceptance

Paper includes desktop/phone and light/dark examples for People search, pending sharing, typed mentions, the bell popover, the inbox, and safe empty/error/unavailable states. Samples are synthetic. Use circular avatars, aligned fixed icon/action lanes, 16px composer input, 44px controls, visible focus and named actions. People suggestions use a combobox/listbox; popovers/sheets return focus. New notifications announce politely in batches without stealing focus. Relative times have accessible exact dates; copy localizes through `@bakery/i18n`.

Implementation acceptance must prove:

1. Name/email search, duplicate first names, no results, missing first name, Unicode, account rename/removal, People versus Integration typing, IME and keyboard/phone selection.
2. A new recipient cannot open the chat before send; after one successful send they can read its shared history and reply. They gain no repository, execution, external, or reshare permission. Selecting/canceling a mention has no side effects.
3. Duplicate requests and concurrent sends create one grant and one notification per logical source/recipient. Failed sharing rolls back the send; revoked/disabled recipients and sender authority changes cannot slip through.
4. Inherited and direct access, independently protected artifacts, revocation, organization switching, and deep-link authentication behave consistently across queries, events, caches and downloads.
5. Mention, task completion/failure/input events persist offline, dedupe replay, and route to the exact message/run/question. Child completion or assistant claims never emit a false task-complete item.
6. Bell/popover/page counts agree; read/unread sync works across two sessions; bulk read uses a cutoff; new arrivals remain unread; unavailable targets and network failures preserve list state.
7. Both themes at phone/pane/rail widths, 200% zoom, 35% copy expansion, RTL, keyboard, screen reader, safe areas and reduced motion. Static mocks do not prove these runtime behaviors.
8. Before push rollout: explicit permission, multiple devices, invalid token cleanup, recipient-access recheck, safe payload, retries, logout/revocation, and cold-start/offline deep links.
