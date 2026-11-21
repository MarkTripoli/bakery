# Provider marks

Vendor marks that Bakery shows beside a destination or an integration. Each file is the vendor's own, never recoloured, resized or edited: `tests/unit/provider-marks_test.ts` compares every file to the SHA-256 recorded here, so a mark cannot change without this table changing with it.

Only the four vendors below publish terms that let Bakery show their mark (UX design revision 4, https://github.com/MarkTripoli/bakery/issues/739#issuecomment-7050762588, terms read on 2026-11-20; not legal advice). Grafana, Datadog, Slack and Honeycomb get a letter tile until the vendor agrees to the mark: adding one means adding two files here, two rows below, and two imports in `packages/ui/src/atoms/provider-marks.ts`.

The files were copied from the design mock source (`design-739/r4/marks`, https://github.com/MarkTripoli/bakery/tree/b931d6e0a6eb6799d5e9d065a2bd4ff32cceb8a9/design-739/r4/marks), where design-ux took them from the vendor's official files on 2026-11-20.

| file | shown on | official source | guideline | fetched | sha256 |
| --- | --- | --- | --- | --- | --- |
| opentelemetry/otel-color.svg | light | https://github.com/cncf/artwork/tree/main/projects/opentelemetry/icon | https://www.linuxfoundation.org/legal/trademark-usage | 2026-11-20 | f19d3aa81895ba0d2102df6bbd76371e55664f8f6714c6ed355f971b7b013906 |
| opentelemetry/otel-white.svg | dark | https://github.com/cncf/artwork/tree/main/projects/opentelemetry/icon | https://www.linuxfoundation.org/legal/trademark-usage | 2026-11-20 | e312f695f1eedcba2b030e2d2d9335201a1eb3b886680db185c6155baa796dc6 |
| sentry/sentry-black.svg | light | https://sentry.io/branding/ (Glyph, clear space off) | https://sentry.io/branding/ | 2026-11-20 | 8a9e5aab8980cf2b5947c9ebbed2e2f6c61d17edd2caf0d881649a4ea02cf9e7 |
| sentry/sentry-white.svg | dark | https://sentry.io/branding/ (Glyph, clear space off) | https://sentry.io/branding/ | 2026-11-20 | dc74e7cd99aa32d0a14be6be0fd76d1d160ef963f3009c4a363da0a01f77a5f5 |
| github/github-black.svg | light | https://brand.github.com/GitHub_Logos.zip (Invertocat) | https://brand.github.com | 2026-11-20 | 693d7abe6f899646cc2e96856723b45e95f71885a54910b2749f6decdf7e1ee1 |
| github/github-white.svg | dark | https://brand.github.com/GitHub_Logos.zip (Invertocat) | https://brand.github.com | 2026-11-20 | ccd84c89b1056345608fc3489357f8acc7397e49a3cdc2d418b6c8016911d47b |
| linear/linear-dark.svg | light | https://static.linear.app/design-assets/Linear-Brand-Assets.zip?v=3 (logo-dark) | https://linear.app/brand | 2026-11-20 | e683e95a5eb9b360ae06360c0350fd1b5fcf3d2222ef9de8e71fa0bc413dccc3 |
| linear/linear-light.svg | dark | https://static.linear.app/design-assets/Linear-Brand-Assets.zip?v=3 (logo-light) | https://linear.app/brand | 2026-11-20 | 32f9883452188b39787f8242c7bfce723ded255f35f13254e727871d3dae2fd1 |
