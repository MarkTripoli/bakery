# PR #523 visual evidence @ f3c28035e

Ink is --color-fg-tertiary per design-ux ruling (6941992556), scoped to the one
dark disabled primary rule (design-ux caught a replace-all at 55efbd7e7).

1. `login-loading-dark-desktop.png` - login loading, dark, 1440x900.
2. `login-loading-dark-phone.png` - login loading, dark, 390x844.
3. `real-buttons-dark.png` - real @bakery/ui Button components, dark:
   disabled primary, enabled secondary, disabled secondary, loading primary.
   Computed ink: disabled primary rgb(125,135,154) = tertiary; enabled and
   disabled secondary rgb(242,244,248) at the 55% the base rule applies.
