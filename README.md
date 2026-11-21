# Stills for the Slack app section (#415)

Head: `14f063eb` — the commit the stills were taken at.

Twelve stills: three states (not set up, set up and accepted, sign-in refused),
two themes, two viewports. Each is the Slack section of
`/settings/installation/integrations`, clipped with padding around it.

How they were made: `apps/web/tests/slack-app-stills.spec.ts` at that head, run
from `apps/web` with

```
BAKERY_EVIDENCE_DIR=/tmp/stills-415c pnpm exec playwright test \
  tests/slack-app-stills.spec.ts --project=desktop --workers=1 --retries=1
```

It reuses the screen's own fixtures (`tests/helpers/installation-integrations-fixtures.ts`),
so a still shows a state `installation-integrations.spec.ts` also asserts. Every
still is written only after the section says what the design promises, so a
blank page or a spinner cannot pass as evidence.

What these stills do not prove: that Slack answers a real request. No Slack call
is made; the two status rows show the words the design specifies for each answer,
from the fixture, not from an answer.

Missing states: the Remove dialog and the "details were removed" banner are not
here. The design specifies both; the dialog and the banner are covered by tests
in the same spec, and no still of them was taken before the head.

### unset, light, desktop-1440x900

![unset light desktop-1440x900](../../stills/415-slack/unset--light--desktop-1440x900.png)

### unset, light, phone-390x844

![unset light phone-390x844](../../stills/415-slack/unset--light--phone-390x844.png)

### unset, dark, desktop-1440x900

![unset dark desktop-1440x900](../../stills/415-slack/unset--dark--desktop-1440x900.png)

### unset, dark, phone-390x844

![unset dark phone-390x844](../../stills/415-slack/unset--dark--phone-390x844.png)

### set, light, desktop-1440x900

![set light desktop-1440x900](../../stills/415-slack/set--light--desktop-1440x900.png)

### set, light, phone-390x844

![set light phone-390x844](../../stills/415-slack/set--light--phone-390x844.png)

### set, dark, desktop-1440x900

![set dark desktop-1440x900](../../stills/415-slack/set--dark--desktop-1440x900.png)

### set, dark, phone-390x844

![set dark phone-390x844](../../stills/415-slack/set--dark--phone-390x844.png)

### refused-check, light, desktop-1440x900

![refused-check light desktop-1440x900](../../stills/415-slack/refused-check--light--desktop-1440x900.png)

### refused-check, light, phone-390x844

![refused-check light phone-390x844](../../stills/415-slack/refused-check--light--phone-390x844.png)

### refused-check, dark, desktop-1440x900

![refused-check dark desktop-1440x900](../../stills/415-slack/refused-check--dark--desktop-1440x900.png)

### refused-check, dark, phone-390x844

![refused-check dark phone-390x844](../../stills/415-slack/refused-check--dark--phone-390x844.png)

