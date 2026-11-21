# Stills for the Slack app section (#415)

Head: `3c85daf6a` — the merged head the stills ship with; taken at `3c85daf6a`.

Twenty-four stills: six states, two themes, two viewports. Each is the
Slack section of `/settings/installation/integrations`, clipped with padding
around it, except the Remove dialog, which is the viewport because a dialog
is its own layer.

The six states:

- **unset**: nothing saved, the three addresses Slack asks for.
- **set**: saved, with the sign-in row saying Slack accepted the details and
  the requests row naming the last delivery.
- **refused-check**: saved, with the sign-in row saying Slack does not
  recognise the client ID.
- **replace-form**: Replace details pressed, both ids filled in, the secrets
  empty with the day they were saved beside them.

Each address row carries its own line saying where in Slack it is pasted, and a
sign-in row Slack refused carries an alert glyph beside its title.
- **remove-dialog**: Remove pressed, the confirmation open.
- **removed**: removed, the banner above the empty form.

How they were made: `apps/web/tests/slack-app-stills.spec.ts` at that head,
run from `apps/web` with

```
BAKERY_EVIDENCE_DIR=/tmp/stills-415d pnpm exec playwright test \
  tests/slack-app-stills.spec.ts --project=desktop --workers=1 --retries=1
```

It reuses the screen's own fixtures
(`tests/helpers/installation-integrations-fixtures.ts`), so a still shows a
state `installation-integrations.spec.ts` also asserts. Every still is
written only after the section says what the design promises, so a blank page
or a spinner cannot pass as evidence. The addresses shown are the ones the
server serves (`/v1/integration-auth/slack/identity-callback`,
`/v1/webhooks/slack/events`, `/v1/webhooks/slack/interactions`).

What these stills do not prove: that Slack answers a real request, or that a
post is delivered. No Slack call is made; the status rows show the words the
design specifies for each answer, from the fixture, not from an answer.

Not here: the Account and security page's Slack row. That row needs a person's
own link state, which no API serves yet; it arrives with the install and
identity-linking slice.

### unset, light, desktop-1440x900

![unset light desktop-1440x900](stills/415-slack/unset--light--desktop-1440x900.png)

### unset, light, phone-390x844

![unset light phone-390x844](stills/415-slack/unset--light--phone-390x844.png)

### unset, dark, desktop-1440x900

![unset dark desktop-1440x900](stills/415-slack/unset--dark--desktop-1440x900.png)

### unset, dark, phone-390x844

![unset dark phone-390x844](stills/415-slack/unset--dark--phone-390x844.png)

### set, light, desktop-1440x900

![set light desktop-1440x900](stills/415-slack/set--light--desktop-1440x900.png)

### set, light, phone-390x844

![set light phone-390x844](stills/415-slack/set--light--phone-390x844.png)

### set, dark, desktop-1440x900

![set dark desktop-1440x900](stills/415-slack/set--dark--desktop-1440x900.png)

### set, dark, phone-390x844

![set dark phone-390x844](stills/415-slack/set--dark--phone-390x844.png)

### refused-check, light, desktop-1440x900

![refused-check light desktop-1440x900](stills/415-slack/refused-check--light--desktop-1440x900.png)

### refused-check, light, phone-390x844

![refused-check light phone-390x844](stills/415-slack/refused-check--light--phone-390x844.png)

### refused-check, dark, desktop-1440x900

![refused-check dark desktop-1440x900](stills/415-slack/refused-check--dark--desktop-1440x900.png)

### refused-check, dark, phone-390x844

![refused-check dark phone-390x844](stills/415-slack/refused-check--dark--phone-390x844.png)

### replace-form, light, desktop-1440x900

![replace-form light desktop-1440x900](stills/415-slack/replace-form--light--desktop-1440x900.png)

### replace-form, light, phone-390x844

![replace-form light phone-390x844](stills/415-slack/replace-form--light--phone-390x844.png)

### replace-form, dark, desktop-1440x900

![replace-form dark desktop-1440x900](stills/415-slack/replace-form--dark--desktop-1440x900.png)

### replace-form, dark, phone-390x844

![replace-form dark phone-390x844](stills/415-slack/replace-form--dark--phone-390x844.png)

### remove-dialog, light, desktop-1440x900

![remove-dialog light desktop-1440x900](stills/415-slack/remove-dialog--light--desktop-1440x900.png)

### remove-dialog, light, phone-390x844

![remove-dialog light phone-390x844](stills/415-slack/remove-dialog--light--phone-390x844.png)

### remove-dialog, dark, desktop-1440x900

![remove-dialog dark desktop-1440x900](stills/415-slack/remove-dialog--dark--desktop-1440x900.png)

### remove-dialog, dark, phone-390x844

![remove-dialog dark phone-390x844](stills/415-slack/remove-dialog--dark--phone-390x844.png)

### removed, light, desktop-1440x900

![removed light desktop-1440x900](stills/415-slack/removed--light--desktop-1440x900.png)

### removed, light, phone-390x844

![removed light phone-390x844](stills/415-slack/removed--light--phone-390x844.png)

### removed, dark, desktop-1440x900

![removed dark desktop-1440x900](stills/415-slack/removed--dark--desktop-1440x900.png)

### removed, dark, phone-390x844

![removed dark phone-390x844](stills/415-slack/removed--dark--phone-390x844.png)

## Provider mark at 200% zoom (`stills/provider-mark-zoom200`)

`before--light.png` is `Bakery/Atoms/ProviderMark` at `f6c3700cf`, where the containment rail measured the unclipped box and the story failed. `after--light.png` and `after--dark.png` are the same story at `a163b2302`, after the rail measures what a clipping ancestor shows and the clear-space slot clips. The glyph size is unchanged; only the escaped clear space is gone.
