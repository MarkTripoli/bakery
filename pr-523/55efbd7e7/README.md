# PR #523 visual evidence @ 55efbd7e7

Ink is --color-fg-tertiary per design-ux ruling (6941992556).

1. `login-loading-dark-desktop.png` - login loading, dark, 1440x900.
2. `login-loading-dark-phone.png` - login loading, dark, 390x844.
3. `real-buttons-dark.png` - real `@bakery/ui` Button components, dark:
   disabled primary ("Save preferences"), enabled secondary ("Cancel"),
   disabled secondary ("Cancel"), and the loading primary ("Working…").
   Rendered ink: disabled primary (125,135,154) < disabled secondary
   (141,144,150) < enabled secondary (242,244,248) - the hierarchy holds.
