# Mock brief

Paper page `p-17-0` (`16 · Product · Access, licence & entitlements`), file
`01M1X504XVC45FC0VDK857A37D`. Every frame reuses the E03 settings shell (208px
rail, 224px SectionNavigation, Geist, file tokens, light and dark token maps).
Desktop 1440 wide, phone 390 wide.

Shell parity (copied from the E03 settings frames, not redrawn): every desktop
frame uses the E03 application rail (brand glyph, workspace switcher, Work to
Settings items with Settings active, recent sessions, account footer), light and
dark. Every phone frame uses the E03 phone navigation: the app bar (menu button,
brand glyph, wordmark, account avatar) over the Settings return row with the
workspace and role. Phone Access (Members, light and dark) shows the same four
sections as desktop, stacked for 390 px: Members, Invitations, Service accounts
and tokens, Connected clients.

Semantics: system roles are Admin, Developer, Viewer, Guest; one paid custom
role example (Release manager) appears on custom-role frames only. The seat,
licence and upsell frames are retired (see Retired frames). User-facing copy never
shows raw error codes.

| surface                     | frame id | device  | theme | state                            | source            |
| --------------------------- | -------- | ------- | ----- | -------------------------------- | ----------------- |
| Installation settings       | 2DA1-0   | desktop | dark  | Default                          | source/2DA1-0.jsx |
| Installation settings       | 2C24-0   | desktop | light | Default                          | source/2C24-0.jsx |
| Installation settings       | 2DYC-0   | phone   | dark  | Default                          | source/2DYC-0.jsx |
| Installation settings       | 2D27-0   | phone   | light | Default                          | source/2D27-0.jsx |
| Installation settings       | 2E5Y-0   | desktop | light | Save conflict                    | source/2E5Y-0.jsx |
| Installation settings       | 2E62-0   | phone   | light | Save conflict                    | source/2E62-0.jsx |
| Installation settings       | 2E5Z-0   | desktop | light | Save error                       | source/2E5Z-0.jsx |
| Installation settings       | 2E63-0   | phone   | light | Save error                       | source/2E63-0.jsx |
| Installation administrators | 2E61-0   | desktop | light | Denied non-admin                 | source/2E61-0.jsx |
| Installation administrators | 2E65-0   | phone   | light | Denied non-admin                 | source/2E65-0.jsx |
| Installation administrators | 2DCR-0   | desktop | dark  | List                             | source/2DCR-0.jsx |
| Installation administrators | 2C4V-0   | desktop | light | List                             | source/2C4V-0.jsx |
| Installation administrators | 2DYD-0   | phone   | dark  | List                             | source/2DYD-0.jsx |
| Installation administrators | 2D28-0   | phone   | light | List                             | source/2D28-0.jsx |
| Installation administrators | 2E60-0   | desktop | light | Revoke confirm                   | source/2E60-0.jsx |
| Installation administrators | 2E64-0   | phone   | light | Revoke confirm                   | source/2E64-0.jsx |
| Access page                 | 2ENV-0   | desktop | light | Empty                            | source/2ENV-0.jsx |
| Access page                 | 2ENY-0   | phone   | light | Empty                            | source/2ENY-0.jsx |
| Access page                 | 2ENX-0   | desktop | light | Error                            | source/2ENX-0.jsx |
| Access page                 | 2EO0-0   | phone   | light | Error                            | source/2EO0-0.jsx |
| Access page                 | 2ENW-0   | desktop | light | Loading                          | source/2ENW-0.jsx |
| Access page                 | 2ENZ-0   | phone   | light | Loading                          | source/2ENZ-0.jsx |
| Access page                 | 2DCW-0   | desktop | dark  | Members                          | source/2DCW-0.jsx |
| Access page                 | 2CCD-0   | desktop | light | Members                          | source/2CCD-0.jsx |
| Access page                 | 2DYI-0   | phone   | dark  | Members                          | source/2DYI-0.jsx |
| Access page                 | 2D2D-0   | phone   | light | Members                          | source/2D2D-0.jsx |
| Custom roles                | 2EXJ-0   | desktop | light | Create or edit                   | source/2EXJ-0.jsx |
| Custom roles                | 2EXP-0   | phone   | light | Create or edit                   | source/2EXP-0.jsx |
| Custom roles                | 2DCX-0   | desktop | dark  | List                             | source/2DCX-0.jsx |
| Custom roles                | 2CGG-0   | desktop | light | List                             | source/2CGG-0.jsx |
| Custom roles                | 2DYJ-0   | phone   | dark  | List                             | source/2DYJ-0.jsx |
| Custom roles                | 2D2E-0   | phone   | light | List                             | source/2D2E-0.jsx |
| Audit log                   | 2EXK-0   | desktop | light | Export dialog                    | source/2EXK-0.jsx |
| Audit log                   | 2EXQ-0   | phone   | light | Export dialog                    | source/2EXQ-0.jsx |
| Audit log                   | 2DCY-0   | desktop | dark  | List                             | source/2DCY-0.jsx |
| Audit log                   | 2CJE-0   | desktop | light | List                             | source/2CJE-0.jsx |
| Audit log                   | 2DYK-0   | phone   | dark  | List                             | source/2DYK-0.jsx |
| Audit log                   | 2D2F-0   | phone   | light | List                             | source/2D2F-0.jsx |
| SSO                         | 2EXL-0   | desktop | light | Add OIDC                         | source/2EXL-0.jsx |
| SSO                         | 2EXR-0   | phone   | light | Add OIDC                         | source/2EXR-0.jsx |
| SSO                         | 2EXM-0   | desktop | light | Add SAML and domain verification | source/2EXM-0.jsx |
| SSO                         | 2EXS-0   | phone   | light | Add SAML and domain verification | source/2EXS-0.jsx |
| SSO                         | 2DCZ-0   | desktop | dark  | List                             | source/2DCZ-0.jsx |
| SSO                         | 2CMC-0   | desktop | light | List                             | source/2CMC-0.jsx |
| SSO                         | 2DYL-0   | phone   | dark  | List                             | source/2DYL-0.jsx |
| SSO                         | 2D2G-0   | phone   | light | List                             | source/2D2G-0.jsx |
| SCIM                        | 2EXO-0   | desktop | light | Revoke and decommission confirm  | source/2EXO-0.jsx |
| SCIM                        | 2EXU-0   | phone   | light | Revoke and decommission confirm  | source/2EXU-0.jsx |
| SCIM                        | 2EXN-0   | desktop | light | Rotate confirm                   | source/2EXN-0.jsx |
| SCIM                        | 2EXT-0   | phone   | light | Rotate confirm                   | source/2EXT-0.jsx |
| SCIM                        | 2DD0-0   | desktop | dark  | Token shown once                 | source/2DD0-0.jsx |
| SCIM                        | 2CPA-0   | desktop | light | Token shown once                 | source/2CPA-0.jsx |
| SCIM                        | 2DYM-0   | phone   | dark  | Token shown once                 | source/2DYM-0.jsx |
| SCIM                        | 2D2H-0   | phone   | light | Token shown once                 | source/2D2H-0.jsx |

## Coverage notes

- Dark theme: main screen of every surface, desktop and phone.
- The audit export dialog is surface 9. The FeatureGate upsell frames of surface 6
  are retired (see Retired frames).
- Revoke confirm and decommission confirm share one SCIM frame per device.
- Invite refusal is surface 5. The grace, expired and seat banners (surfaces 4
  and 5) are retired (see Retired frames).

## Retired frames

Thirty frames were retired because Bakery is a single edition with no paid gate
(PM decision on #80,
https://github.com/MarkTripoli/bakery/issues/80#issuecomment-7031029946;
docs/technical-design/PRODUCT.md line 55): Licence page (14), Licence banners
(6, grace and expired), Seat banner (4) and FeatureGate upsell (6). None had a
baseline case or a committed reference image. Their JSX, computed styles and
generated fragments are deleted, and the source manifest lists the 54 frames
that remain.
